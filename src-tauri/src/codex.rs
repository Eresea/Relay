use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

use crate::error::{Error, Result};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const TURN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_PROMPT_LENGTH: usize = 64_000;
const THREAD_PAGE_SIZE: u64 = 50;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRun {
    pub thread_id: String,
    pub response: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadDetails {
    pub thread: Value,
    pub older_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnPage {
    pub turns: Vec<Value>,
    pub next_cursor: Option<String>,
}

#[derive(Default)]
pub struct CodexState {
    client: Mutex<Option<CodexClient>>,
}

impl CodexState {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let mut client = self.client.lock().await;
        if client.is_none() {
            let cwd = appserver_working_directory()?;
            *client = Some(CodexClient::start(&cwd).await?);
        }
        match client
            .as_mut()
            .expect("Codex client was started")
            .request(method, params)
            .await
        {
            Ok(result) => {
                // Read-only clients have no turn waiting for these notifications.
                client
                    .as_mut()
                    .expect("Codex client was started")
                    .pending
                    .clear();
                Ok(result)
            }
            Err(error) => {
                client.take();
                Err(error)
            }
        }
    }
}

struct CodexClient {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
    pending: VecDeque<Value>,
}

fn codex_executable() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(binary) = std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .map(|directory| directory.join("codex.exe"))
            .find(|binary| binary.is_file())
        {
            return binary;
        }
        // ponytail: desktop layout is a fallback; standalone CLI on PATH takes precedence.
        if let Some(binary) = std::env::var_os("LOCALAPPDATA")
            .and_then(|root| std::fs::read_dir(PathBuf::from(root).join("OpenAI/Codex/bin")).ok())
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path().join("codex.exe"))
            .filter(|binary| binary.is_file())
            .max_by_key(|binary| {
                binary
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .ok()
            })
        {
            return binary;
        }
    }
    PathBuf::from("codex")
}

impl CodexClient {
    async fn start(working_directory: &Path) -> Result<Self> {
        let mut child = Command::new(codex_executable())
            .args(["app-server", "--stdio"])
            .current_dir(working_directory)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                protocol_error(format!(
                    "Could not start Codex app-server. Install Codex desktop or put the Codex CLI executable on PATH, then sign in with ChatGPT to use your Codex plan: {error}"
                ))
            })?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| protocol_error("Codex app-server input is unavailable"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| protocol_error("Codex app-server output is unavailable"))?;
        let mut client = Self {
            _child: child,
            input,
            output: BufReader::new(output),
            next_id: 1,
            pending: VecDeque::new(),
        };

        client
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": "relay",
                        "title": "Relay",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
            .await?;
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&json!({ "method": method, "id": id, "params": params }))
            .await?;

        loop {
            let message = self.read(REQUEST_TIMEOUT).await?;
            if message.get("id").is_some() && message.get("method").is_some() {
                self.reject_server_request(&message).await?;
                continue;
            }
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                if message.get("id").is_none() {
                    self.pending.push_back(message);
                }
                continue;
            }
            if let Some(error) = message.get("error") {
                let detail = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex app-server rejected the request");
                return Err(protocol_error(detail));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| protocol_error("Codex app-server returned no result"));
        }
    }

    async fn reject_server_request(&mut self, message: &Value) -> Result<()> {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| protocol_error("Codex sent an invalid server request"))?;
        let id = message
            .get("id")
            .ok_or_else(|| protocol_error("Codex sent a server request without an id"))?;
        let response = match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                json!({ "decision": "decline" })
            }
            "item/permissions/requestApproval" => json!({ "permissions": {} }),
            "mcpServer/elicitation/request" => json!({ "action": "decline" }),
            _ => {
                return Err(protocol_error(format!(
                    "Relay does not support the Codex request: {method}"
                )));
            }
        };
        self.write(&json!({ "method": method, "id": id, "response": response }))
            .await
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.write(&json!({ "method": method, "params": params }))
            .await
    }

    async fn write(&mut self, message: &Value) -> Result<()> {
        self.input.write_all(message.to_string().as_bytes()).await?;
        self.input.write_all(b"\n").await?;
        self.input.flush().await?;
        Ok(())
    }

    async fn read(&mut self, timeout: Duration) -> Result<Value> {
        let mut line = String::new();
        let read = tokio::time::timeout(timeout, self.output.read_line(&mut line))
            .await
            .map_err(|_| protocol_error("Codex app-server timed out"))??;
        if read == 0 {
            return Err(protocol_error("Codex app-server closed the connection"));
        }
        serde_json::from_str(&line)
            .map_err(|_| protocol_error("Codex app-server returned invalid JSON"))
    }

    async fn read_next(&mut self, timeout: Duration) -> Result<Value> {
        match self.pending.pop_front() {
            Some(message) => Ok(message),
            None => self.read(timeout).await,
        }
    }

    async fn run_turn(&mut self, thread_id: &str, cwd: &Path, prompt: &str) -> Result<String> {
        let started = self
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "cwd": cwd.to_string_lossy(),
                    "approvalPolicy": "never",
                    "sandboxPolicy": {
                        "type": "workspaceWrite",
                        "writableRoots": [cwd.to_string_lossy()],
                        "readOnlyAccess": {
                            "type": "restricted",
                            "includePlatformDefaults": true,
                            "readableRoots": [cwd.to_string_lossy()]
                        },
                        "networkAccess": false
                    },
                    "input": [{ "type": "text", "text": prompt }]
                }),
            )
            .await?;
        let turn_id = started
            .get("turn")
            .and_then(|turn| turn.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| protocol_error("Codex app-server returned no turn id"))?;
        let mut response = String::new();

        tokio::time::timeout(TURN_TIMEOUT, async {
            loop {
                let message = self.read_next(TURN_TIMEOUT).await?;
                if message.get("id").is_some() && message.get("method").is_some() {
                    self.reject_server_request(&message).await?;
                    continue;
                }
                match message.get("method").and_then(Value::as_str) {
                    Some("item/agentMessage/delta")
                        if message.pointer("/params/turnId").and_then(Value::as_str)
                            == Some(turn_id) =>
                    {
                        if let Some(delta) =
                            message.pointer("/params/delta").and_then(Value::as_str)
                        {
                            response.push_str(delta);
                        }
                    }
                    Some("turn/completed")
                        if message.pointer("/params/turn/id").and_then(Value::as_str)
                            == Some(turn_id) =>
                    {
                        let turn = &message["params"]["turn"];
                        if turn.get("status").and_then(Value::as_str) != Some("completed") {
                            let detail = turn
                                .pointer("/error/message")
                                .and_then(Value::as_str)
                                .unwrap_or("Codex did not complete the turn");
                            return Err(protocol_error(detail));
                        }
                        if response.is_empty() {
                            response = final_agent_message(turn);
                        }
                        return Ok(());
                    }
                    _ => {}
                }
            }
        })
        .await
        .map_err(|_| protocol_error("Codex turn timed out"))??;

        Ok(response)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadPage {
    pub threads: Vec<Value>,
    pub next_cursor: Option<String>,
}

pub async fn list_threads(state: &CodexState, cursor: Option<String>) -> Result<CodexThreadPage> {
    let page = state
        .request(
            "thread/list",
            json!({
                "limit": THREAD_PAGE_SIZE,
                "cursor": cursor,
                "sortKey": "recency_at",
                "sortDirection": "desc"
            }),
        )
        .await?;
    Ok(CodexThreadPage {
        threads: page
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| protocol_error("Codex app-server returned an invalid thread list"))?,
        next_cursor: page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

pub async fn read_thread(state: &CodexState, thread_id: String) -> Result<CodexThreadDetails> {
    if thread_id.trim().is_empty() {
        return Err(protocol_error("Thread ID cannot be empty"));
    }
    let result = state
        .request("thread/read", json!({ "threadId": thread_id }))
        .await?;
    let mut thread = result
        .get("thread")
        .cloned()
        .ok_or_else(|| protocol_error("Codex app-server returned no thread"))?;
    let older_cursor = if thread.get("historyMode").and_then(Value::as_str) == Some("paginated") {
        let page = older_turns(state, thread_id, None).await?;
        thread["turns"] = json!(page.turns);
        page.next_cursor
    } else {
        let result = state
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": true }),
            )
            .await?;
        thread = result
            .get("thread")
            .cloned()
            .ok_or_else(|| protocol_error("Codex app-server returned no thread"))?;
        None
    };
    Ok(CodexThreadDetails {
        thread,
        older_cursor,
    })
}

pub async fn older_turns(
    state: &CodexState,
    thread_id: String,
    cursor: Option<String>,
) -> Result<CodexTurnPage> {
    parse_turn_page(
        state
            .request(
                "thread/turns/list",
                json!({
                    "threadId": thread_id,
                    "cursor": cursor,
                    "limit": 12,
                    "sortDirection": "desc",
                    "itemsView": "full"
                }),
            )
            .await?,
    )
}

fn parse_turn_page(page: Value) -> Result<CodexTurnPage> {
    let mut turns = page
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| protocol_error("Codex app-server returned invalid thread turns"))?;
    // The server pages newest-first; reverse turns, preserving each turn's item order.
    turns.reverse();
    Ok(CodexTurnPage {
        turns,
        next_cursor: page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn appserver_working_directory() -> Result<PathBuf> {
    let cwd = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    Ok(std::fs::canonicalize(cwd)?)
}

pub async fn send(
    prompt: String,
    working_directory: String,
    thread_id: Option<String>,
) -> Result<CodexRun> {
    let prompt = prompt.trim();
    if prompt.is_empty() || prompt.len() > MAX_PROMPT_LENGTH {
        return Err(protocol_error("Prompt must be between 1 and 64,000 bytes"));
    }
    let cwd = std::fs::canonicalize(working_directory)?;
    if !cwd.is_dir() {
        return Err(protocol_error(
            "Working directory must be an existing folder",
        ));
    }
    let discovered = crate::workspaces::scan()?;
    if !discovered
        .iter()
        .any(|workspace| std::fs::canonicalize(&workspace.path).is_ok_and(|path| path == cwd))
    {
        return Err(protocol_error(
            "Choose a workspace discovered by Relay before sending work to Codex",
        ));
    }

    let mut client = CodexClient::start(&cwd).await?;
    let thread = if let Some(thread_id) = thread_id.filter(|id| !id.trim().is_empty()) {
        client
            .request(
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "cwd": cwd.to_string_lossy(),
                    "approvalPolicy": "never",
                    "sandbox": "workspace-write"
                }),
            )
            .await?
    } else {
        client
            .request(
                "thread/start",
                json!({
                    "cwd": cwd.to_string_lossy(),
                    "approvalPolicy": "never",
                    "sandbox": "workspace-write"
                }),
            )
            .await?
    };
    let thread_id = thread
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or_else(|| protocol_error("Codex app-server returned no thread id"))?
        .to_owned();
    let response = client.run_turn(&thread_id, &cwd, prompt).await?;
    Ok(CodexRun {
        thread_id,
        response,
    })
}

fn final_agent_message(turn: &Value) -> String {
    turn.get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("agentMessage"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn protocol_error(message: impl std::fmt::Display) -> Error {
    std::io::Error::other(message.to_string()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_pages_reverse_turns_without_reversing_messages() {
        let page = parse_turn_page(json!({
            "data": [
                {"id": "newer", "items": [{"type": "userMessage"}, {"type": "agentMessage"}]},
                {"id": "older", "items": [{"type": "userMessage"}, {"type": "agentMessage"}]}
            ],
            "nextCursor": "earlier"
        }))
        .unwrap();
        assert_eq!(page.turns[0]["id"], "older");
        assert_eq!(page.turns[1]["id"], "newer");
        assert_eq!(page.turns[0]["items"][0]["type"], "userMessage");
        assert_eq!(page.next_cursor.as_deref(), Some("earlier"));
        assert!(parse_turn_page(json!({"data": null})).is_err());
    }

    #[tokio::test]
    #[ignore = "requires a signed-in local Codex profile"]
    async fn local_threads_list_and_read() {
        let state = CodexState::default();
        let page = list_threads(&state, None).await.unwrap();
        assert!(
            !page.threads.is_empty(),
            "Expected existing local Codex threads"
        );
        let id = page.threads[0]["id"].as_str().unwrap();
        let details = read_thread(&state, id.to_owned()).await.unwrap();
        assert_eq!(details.thread["id"], id);
        let turns = details.thread["turns"].as_array().unwrap();
        assert!(!turns.is_empty(), "Expected a readable existing transcript");
        println!(
            "Listed {} threads; opened {} recent turns",
            page.threads.len(),
            turns.len()
        );
    }
}
