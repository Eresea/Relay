use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Value};
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

struct CodexClient {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
    pending: VecDeque<Value>,
}

impl CodexClient {
    async fn start(working_directory: &Path) -> Result<Self> {
        let mut child = Command::new("codex")
            .args(["app-server", "--stdio"])
            .current_dir(working_directory)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                protocol_error(format!(
                    "Could not start Codex app-server. Install Codex CLI, sign in, and ensure codex is on PATH: {error}"
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
                    Some("item/agentMessage/delta") => {
                        if message.pointer("/params/turnId").and_then(Value::as_str)
                            == Some(turn_id)
                        {
                            if let Some(delta) =
                                message.pointer("/params/delta").and_then(Value::as_str)
                            {
                                response.push_str(delta);
                            }
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

    async fn read_thread(&mut self, thread_id: &str) -> Result<Value> {
        if thread_id.trim().is_empty() {
            return Err(protocol_error("Thread ID cannot be empty"));
        }
        let response = self
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": true }),
            )
            .await;
        let mut thread = match response {
            Ok(response) => response
                .get("thread")
                .cloned()
                .ok_or_else(|| protocol_error("Codex app-server returned no thread"))?,
            Err(_) => self
                .request("thread/read", json!({ "threadId": thread_id }))
                .await?
                .get("thread")
                .cloned()
                .ok_or_else(|| protocol_error("Codex app-server returned no thread"))?,
        };

        let needs_full_history =
            thread
                .get("turns")
                .and_then(Value::as_array)
                .is_none_or(|turns| {
                    thread.get("historyMode").and_then(Value::as_str) == Some("paginated")
                        || turns.iter().any(|turn| {
                            turn.get("itemsView")
                                .and_then(Value::as_str)
                                .is_some_and(|view| view != "full")
                        })
                });
        if needs_full_history {
            let mut turns = Vec::new();
            let mut cursor: Option<String> = None;
            loop {
                let mut params = json!({
                    "threadId": thread_id,
                    "limit": THREAD_PAGE_SIZE,
                    "sortDirection": "desc",
                    "itemsView": "full"
                });
                if let Some(cursor) = cursor.as_ref() {
                    params["cursor"] = json!(cursor);
                }
                let page = self.request("thread/turns/list", params).await?;
                let page_turns = page.get("data").and_then(Value::as_array).ok_or_else(|| {
                    protocol_error("Codex app-server returned invalid thread turns")
                })?;
                turns.extend(page_turns.iter().cloned());
                cursor = page
                    .get("nextCursor")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if cursor.is_none() {
                    break;
                }
            }
            turns.reverse();
            thread["turns"] = Value::Array(turns);
        }

        Ok(thread)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadPage {
    pub threads: Vec<Value>,
    pub next_cursor: Option<String>,
}

pub async fn list_threads(cursor: Option<String>) -> Result<CodexThreadPage> {
    let cwd = appserver_working_directory()?;
    let mut client = CodexClient::start(&cwd).await?;
    let mut params = json!({
        "limit": THREAD_PAGE_SIZE,
        "sortKey": "recency_at",
        "sortDirection": "desc",
        "sourceKinds": ["cli", "vscode", "appServer", "exec"]
    });
    if let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) {
        params["cursor"] = json!(cursor);
    }
    let page = client.request("thread/list", params).await?;
    let threads = page
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| protocol_error("Codex app-server returned an invalid thread list"))?;
    Ok(CodexThreadPage {
        threads,
        next_cursor: page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

pub async fn read_thread(thread_id: String) -> Result<Value> {
    let cwd = appserver_working_directory()?;
    CodexClient::start(&cwd)
        .await?
        .read_thread(&thread_id)
        .await
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
