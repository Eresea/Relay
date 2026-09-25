use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

use crate::error::{Error, Result};

const RESPONSE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThread {
    id: String,
    title: String,
    cwd: String,
    updated_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadDetails {
    pub thread: CodexThread,
    pub messages: Vec<CodexMessage>,
    pub older_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMessagePage {
    pub messages: Vec<CodexMessage>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMessage {
    pub role: &'static str,
    pub text: String,
}

#[derive(Default)]
pub struct CodexState {
    client: Mutex<Option<CodexClient>>,
}

impl CodexState {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let mut client = self.client.lock().await;
        if client.is_none() {
            *client = Some(CodexClient::start().await?);
        }
        match client
            .as_mut()
            .expect("Codex client was started")
            .request(method, params)
            .await
        {
            Ok(result) => Ok(result),
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
}

impl CodexClient {
    async fn start() -> Result<Self> {
        let mut child = Command::new("codex")
            .args(["app-server", "--stdio"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
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
        };

        client
            .request(
                "initialize",
                json!({
                    "clientInfo": { "name": "relay", "title": "Relay", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true }
                }),
            )
            .await?;
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({ "method": method, "id": id, "params": params });
        self.write_message(&request).await?;

        loop {
            let mut line = String::new();
            let read = tokio::time::timeout(RESPONSE_TIMEOUT, self.output.read_line(&mut line))
                .await
                .map_err(|_| protocol_error("Codex app-server timed out"))??;
            if read == 0 {
                return Err(protocol_error("Codex app-server closed the connection"));
            }

            let message: Value = serde_json::from_str(&line)
                .map_err(|_| protocol_error("Codex app-server returned invalid JSON"))?;
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if message.get("error").is_some() {
                return Err(protocol_error("Codex app-server rejected the request"));
            }
            return message
                .get("result")
                .cloned()
                .ok_or_else(|| protocol_error("Codex app-server returned no result"));
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.write_message(&json!({ "method": method, "params": params }))
            .await
    }

    async fn write_message(&mut self, message: &Value) -> Result<()> {
        self.input.write_all(message.to_string().as_bytes()).await?;
        self.input.write_all(b"\n").await?;
        self.input.flush().await?;
        Ok(())
    }
}

fn parse_threads(result: Value) -> Result<Vec<CodexThread>> {
    let threads = result
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| protocol_error("Codex app-server returned an invalid thread list"))?;

    Ok(threads
        .iter()
        .filter_map(|thread| {
            Some(CodexThread {
                id: thread.get("id")?.as_str()?.to_owned(),
                title: thread
                    .get("title")
                    .and_then(Value::as_str)
                    .or_else(|| thread.get("preview").and_then(Value::as_str))
                    .unwrap_or("Untitled thread")
                    .lines()
                    .next()
                    .unwrap_or("Untitled thread")
                    .to_owned(),
                cwd: thread.get("cwd")?.as_str()?.to_owned(),
                updated_at: thread.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect())
}

fn parse_thread_details(result: Value) -> Result<CodexThreadDetails> {
    let thread = result
        .get("thread")
        .ok_or_else(|| protocol_error("Codex app-server returned no thread"))?;
    let summary = CodexThread {
        id: thread
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| protocol_error("Codex app-server returned an invalid thread"))?
            .to_owned(),
        title: thread
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| thread.get("preview").and_then(Value::as_str))
            .unwrap_or("Untitled thread")
            .lines()
            .next()
            .unwrap_or("Untitled thread")
            .to_owned(),
        cwd: result
            .get("cwd")
            .and_then(Value::as_str)
            .or_else(|| thread.get("cwd").and_then(Value::as_str))
            .ok_or_else(|| protocol_error("Codex app-server returned an invalid workspace"))?
            .to_owned(),
        updated_at: thread.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
    };

    let initial_page = result.get("initialTurnsPage");
    let turns = initial_page
        .and_then(|page| page.get("data"))
        .or_else(|| thread.get("turns"));
    let mut messages = parse_turn_messages(turns);
    if initial_page.is_some() {
        messages.reverse();
    }

    Ok(CodexThreadDetails {
        thread: summary,
        messages,
        older_cursor: initial_page
            .and_then(|page| page.get("nextCursor"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn parse_turn_messages(turns: Option<&Value>) -> Vec<CodexMessage> {
    turns
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|turn| {
            turn.get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(message_from_item)
        .collect()
}

fn parse_message_page(result: Value) -> Result<CodexMessagePage> {
    let data = result
        .get("data")
        .ok_or_else(|| protocol_error("Codex app-server returned an invalid message page"))?;
    let mut messages = parse_turn_messages(Some(data));
    messages.reverse();
    Ok(CodexMessagePage {
        messages,
        next_cursor: result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

#[tauri::command]
pub async fn codex_threads(state: State<'_, CodexState>) -> Result<Vec<CodexThread>> {
    parse_threads(state.request("thread/list", json!({ "limit": 50 })).await?)
}

#[tauri::command]
pub async fn codex_open_thread(
    state: State<'_, CodexState>,
    thread_id: String,
) -> Result<CodexThreadDetails> {
    parse_thread_details(
        state
            .request(
                "thread/resume",
                json!({
                    "threadId": thread_id,
                    "excludeTurns": true,
                    "initialTurnsPage": {
                        "limit": 12,
                        "sortDirection": "desc",
                        "itemsView": "summary"
                    }
                }),
            )
            .await?,
    )
}

#[tauri::command]
pub async fn codex_older_messages(
    state: State<'_, CodexState>,
    thread_id: String,
    cursor: String,
) -> Result<CodexMessagePage> {
    parse_message_page(
        state
            .request(
                "thread/turns/list",
                json!({
                    "threadId": thread_id,
                    "cursor": cursor,
                    "limit": 12,
                    "sortDirection": "desc",
                    "itemsView": "summary"
                }),
            )
            .await?,
    )
}

fn message_from_item(item: &Value) -> Option<CodexMessage> {
    let kind = item.get("type")?.as_str()?;
    let role = match kind {
        "userMessage" => "You",
        "agentMessage" => "Codex",
        _ => return None,
    };
    let text = item
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            item.get("content")
                .and_then(Value::as_array)
                .map(|content| {
                    content
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
        })
        .filter(|text| !text.trim().is_empty())?;
    Some(CodexMessage { role, text })
}

fn protocol_error(message: &'static str) -> Error {
    std::io::Error::other(message).into()
}
