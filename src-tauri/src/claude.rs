//! Claude Code, driven headless, asking you before it acts.
//!
//! A turn is one `claude -p` run in a workspace speaking stream-json: the
//! prompt goes in as a JSON message on stdin, so no shell ever parses it, and
//! `--resume` continues a session. With `--permission-prompt-tool stdio`,
//! every tool Claude Code would otherwise have to ask about — an edit, a
//! command — arrives here as a `can_use_tool` control request; the [`Host`]
//! asks you (the attention stack's Allow and Deny) and the answer goes back
//! on stdin. This is the control channel the Claude Agent SDKs use.
//!
//! Sessions are read from Claude Code's own transcripts
//! (`~/.claude/projects/<folder>/<session>.jsonl`). That format is internal
//! to Claude Code, so parsing takes only what it recognises — ids, the
//! working folder, plain text — and skips everything else.

use std::{
    fs::File,
    future::Future,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader as AsyncBufReader},
    process::Command,
};

use crate::error::{Error, Result};

/// Includes the time spent waiting on you.
const TURN_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const MAX_PROMPT_LENGTH: usize = 64_000;
const SESSION_LIMIT: usize = 50;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRun {
    pub session_id: String,
    pub response: String,
    pub cost_usd: Option<f64>,
}

/// A tool Claude Code wants to use, in words you can decide on.
#[derive(Debug, PartialEq)]
pub struct PermissionRequest {
    pub tool: String,
    /// "Run `npm test`", "Edit src/app.tsx".
    pub summary: String,
}

/// Whoever runs the turn: shows what Claude is doing and answers its
/// permission requests.
pub trait Host: Send {
    fn progress(&mut self, tool: &str);
    fn approve(&mut self, request: PermissionRequest) -> impl Future<Output = bool> + Send;
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionSummary {
    pub id: String,
    pub title: String,
    pub cwd: String,
    /// Seconds since the epoch, from the transcript's modification time.
    pub updated_at: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMessage {
    pub role: &'static str,
    pub text: String,
    pub timestamp: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    #[serde(flatten)]
    pub summary: ClaudeSessionSummary,
    pub messages: Vec<ClaudeMessage>,
}

fn claude_error(message: impl std::fmt::Display) -> Error {
    std::io::Error::other(message.to_string()).into()
}

/// The CLI on PATH. npm installs it as a `.cmd` shim on Windows, which
/// `Command` only finds by its full name.
fn claude_executable() -> PathBuf {
    #[cfg(windows)]
    {
        let dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|path| std::env::split_paths(&path).collect())
            .unwrap_or_default();
        for name in ["claude.exe", "claude.cmd"] {
            if let Some(binary) = dirs.iter().map(|d| d.join(name)).find(|b| b.is_file()) {
                return binary;
            }
        }
    }
    PathBuf::from("claude")
}

/// Claude Code's data folder: `CLAUDE_CONFIG_DIR`, or `.claude` in home.
fn config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".claude"))
}

/// Session ids are UUIDs; anything else never reaches the command line.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// One line of Claude Code's stream-json output, as far as Relay cares.
#[derive(Debug, PartialEq)]
enum Event {
    Permission {
        request_id: String,
        tool: String,
        input: Value,
    },
    /// The assistant started using a tool.
    Tool(String),
    Done(std::result::Result<ClaudeRun, String>),
    Other,
}

fn read_event(line: &str) -> Event {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Event::Other;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("control_request")
            if value.pointer("/request/subtype").and_then(Value::as_str)
                == Some("can_use_tool") =>
        {
            Event::Permission {
                request_id: value
                    .get("request_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                tool: value
                    .pointer("/request/tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or("a tool")
                    .to_owned(),
                input: value
                    .pointer("/request/input")
                    .cloned()
                    .unwrap_or(Value::Null),
            }
        }
        Some("assistant") => value
            .pointer("/message/content")
            .and_then(Value::as_array)
            .and_then(|blocks| {
                blocks
                    .iter()
                    .find(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
            })
            .and_then(|block| block.get("name").and_then(Value::as_str))
            .map_or(Event::Other, |name| Event::Tool(name.to_owned())),
        Some("result") => Event::Done(read_result(&value)),
        _ => Event::Other,
    }
}

fn read_result(value: &Value) -> std::result::Result<ClaudeRun, String> {
    let text = value.get("result").and_then(Value::as_str).unwrap_or("");
    if value.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(if text.is_empty() {
            "Claude Code could not finish the turn".to_owned()
        } else {
            text.to_owned()
        });
    }
    let session_id = value
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or("Claude Code returned no session")?;
    Ok(ClaudeRun {
        session_id: session_id.to_owned(),
        response: text.to_owned(),
        cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
    })
}

fn clip(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        return text;
    }
    format!(
        "{}…",
        text.chars().take(max - 1).collect::<String>().trim_end()
    )
}

/// What a tool request would do, in a line short enough for a card.
fn summarize_request(tool: &str, input: &Value) -> String {
    let field = |name: &str| input.get(name).and_then(Value::as_str);
    match (tool, field("command"), field("file_path"), field("url")) {
        ("Bash" | "PowerShell", Some(command), _, _) => format!("Run `{}`", clip(command, 140)),
        ("Write", _, Some(path), _) => format!("Write {path}"),
        ("Edit" | "MultiEdit" | "NotebookEdit", _, Some(path), _) => format!("Edit {path}"),
        (_, _, _, Some(url)) => format!("{tool} {}", clip(url, 140)),
        _ => format!("Use {tool} · {}", clip(&input.to_string(), 120)),
    }
}

/// The answer to a `can_use_tool` request, as the control protocol expects it.
fn permission_reply(request_id: &str, allow: bool, input: &Value) -> String {
    let decision = if allow {
        json!({ "behavior": "allow", "updatedInput": input })
    } else {
        json!({ "behavior": "deny", "message": "Declined in Relay." })
    };
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": decision },
    })
    .to_string()
}

fn user_message(prompt: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": prompt },
        "parent_tool_use_id": null,
        "session_id": "",
    })
    .to_string()
}

/// Runs one turn in `working_directory`, new or resuming `session_id`,
/// routing every permission request through `host`.
pub async fn run(
    prompt: String,
    working_directory: String,
    session_id: Option<String>,
    host: &mut impl Host,
) -> Result<ClaudeRun> {
    let prompt = prompt.trim().to_owned();
    if prompt.is_empty() {
        return Err(claude_error("Ask Claude something first"));
    }
    if prompt.len() > MAX_PROMPT_LENGTH {
        return Err(claude_error("That prompt is too long for one turn"));
    }
    let folder = Path::new(&working_directory);
    if !folder.is_dir() {
        return Err(claude_error(format!("{working_directory} is not a folder")));
    }
    let mut command = Command::new(claude_executable());
    command.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-prompt-tool",
        "stdio",
    ]);
    if let Some(id) = session_id.as_deref() {
        if !valid_session_id(id) {
            return Err(claude_error("That is not a Claude Code session id"));
        }
        command.args(["--resume", id]);
    }
    let mut child = command
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            claude_error(format!(
                "Could not start Claude Code. Install it (npm install -g @anthropic-ai/claude-code) and sign in once in a terminal: {error}"
            ))
        })?;
    let (Some(mut stdin), Some(stdout), Some(mut stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err(claude_error("Claude Code's pipes are unavailable"));
    };
    // Drained alongside, or a chatty CLI would block on a full pipe.
    let errors = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });

    stdin
        .write_all(format!("{}\n", user_message(&prompt)).as_bytes())
        .await?;
    let mut lines = AsyncBufReader::new(stdout).lines();
    let turn = async {
        while let Some(line) = lines.next_line().await? {
            match read_event(&line) {
                Event::Permission {
                    request_id,
                    tool,
                    input,
                } => {
                    let summary = summarize_request(&tool, &input);
                    let allow = host.approve(PermissionRequest { tool, summary }).await;
                    let reply = permission_reply(&request_id, allow, &input);
                    stdin.write_all(format!("{reply}\n").as_bytes()).await?;
                }
                Event::Tool(name) => host.progress(&name),
                Event::Done(result) => return Ok(Some(result)),
                Event::Other => {}
            }
        }
        Ok::<_, Error>(None)
    };
    let outcome = tokio::time::timeout(TURN_TIMEOUT, turn)
        .await
        .map_err(|_| claude_error("Claude Code took longer than an hour"))??;
    // The turn is over: closing stdin lets the CLI exit.
    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;

    match outcome {
        Some(result) => result.map_err(claude_error),
        // No result at all: the CLI failed before a turn began; stderr says why.
        None => {
            let stderr = errors.await.unwrap_or_default();
            let why = stderr
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("Claude Code stopped without an answer");
            Err(claude_error(why.trim()))
        }
    }
}

/// The text a user or assistant record carries, or None for tool traffic,
/// thinking, and the wrappers Claude Code adds around commands and context.
fn message_text(record: &Value) -> Option<String> {
    let content = record.pointer("/message/content")?;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty() && !text.starts_with('<')).then(|| text.to_owned())
}

fn records(path: &Path) -> Result<impl Iterator<Item = Value>> {
    Ok(BufReader::new(File::open(path)?)
        .lines()
        .map_while(std::result::Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter(|record| record.get("isSidechain").and_then(Value::as_bool) != Some(true)))
}

fn modified_secs(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

fn title_of(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or(text)
        .trim();
    if line.chars().count() <= 80 {
        return line.to_owned();
    }
    format!("{}…", line.chars().take(79).collect::<String>().trim_end())
}

/// A session's id, folder and first prompt. Stops reading at the first
/// prompt, so a long transcript costs no more than a short one.
fn summarize(path: &Path) -> Option<ClaudeSessionSummary> {
    let id = path.file_stem()?.to_str()?.to_owned();
    let mut cwd = None;
    let mut title = None;
    for record in records(path).ok()? {
        if cwd.is_none() {
            cwd = record.get("cwd").and_then(Value::as_str).map(str::to_owned);
        }
        if title.is_none() && record.get("type").and_then(Value::as_str) == Some("user") {
            title = message_text(&record).map(|text| title_of(&text));
        }
        if cwd.is_some() && title.is_some() {
            break;
        }
    }
    Some(ClaudeSessionSummary {
        id,
        title: title?,
        cwd: cwd.unwrap_or_default(),
        updated_at: modified_secs(path),
    })
}

fn transcripts(root: &Path) -> Vec<PathBuf> {
    let Ok(folders) = std::fs::read_dir(root.join("projects")) else {
        return Vec::new();
    };
    let mut files: Vec<(u64, PathBuf)> = folders
        .flatten()
        .filter_map(|folder| std::fs::read_dir(folder.path()).ok())
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .map(|path| (modified_secs(&path), path))
        .collect();
    files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    files.into_iter().map(|(_, path)| path).collect()
}

/// The most recent sessions, newest first. Sessions with no prompt of
/// their own (only tool traffic) are left out.
pub fn list_sessions_in(root: &Path) -> Vec<ClaudeSessionSummary> {
    transcripts(root)
        .iter()
        .filter_map(|path| summarize(path))
        .take(SESSION_LIMIT)
        .collect()
}

pub fn read_session_in(root: &Path, id: &str) -> Result<ClaudeSession> {
    if !valid_session_id(id) {
        return Err(claude_error("That is not a Claude Code session id"));
    }
    let path = transcripts(root)
        .into_iter()
        .find(|path| path.file_stem().and_then(|s| s.to_str()) == Some(id))
        .ok_or_else(|| claude_error("No such Claude Code session"))?;
    let summary = summarize(&path).ok_or_else(|| claude_error("That session has no prompts"))?;
    let messages = records(&path)?
        .filter_map(|record| {
            let role = match record.get("type").and_then(Value::as_str)? {
                "user" => "user",
                "assistant" => "assistant",
                _ => return None,
            };
            Some(ClaudeMessage {
                role,
                text: message_text(&record)?,
                timestamp: record
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect();
    Ok(ClaudeSession { summary, messages })
}

pub fn list_sessions() -> Vec<ClaudeSessionSummary> {
    config_dir().map_or_else(Vec::new, |root| list_sessions_in(&root))
}

pub fn read_session(id: &str) -> Result<ClaudeSession> {
    let root = config_dir().ok_or_else(|| claude_error("No home folder to find Claude Code in"))?;
    read_session_in(&root, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_result_carries_the_answer_session_and_cost() {
        let event = read_event(
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Hi","session_id":"0f3a-9c","total_cost_usd":0.012}"#,
        );
        assert_eq!(
            event,
            Event::Done(Ok(ClaudeRun {
                session_id: "0f3a-9c".into(),
                response: "Hi".into(),
                cost_usd: Some(0.012),
            }))
        );
    }

    #[test]
    fn an_error_result_says_why() {
        assert_eq!(
            read_event(r#"{"type":"result","is_error":true,"result":"Credit balance is too low"}"#),
            Event::Done(Err("Credit balance is too low".into()))
        );
        assert_eq!(read_event("not json"), Event::Other);
    }

    #[test]
    fn a_permission_request_is_read_and_answered_in_the_sdk_shape() {
        let event = read_event(
            r#"{"type":"control_request","request_id":"r7","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"npm test"}}}"#,
        );
        let Event::Permission {
            request_id,
            tool,
            input,
        } = event
        else {
            panic!("expected a permission request, got {event:?}");
        };
        assert_eq!((request_id.as_str(), tool.as_str()), ("r7", "Bash"));
        assert_eq!(summarize_request(&tool, &input), "Run `npm test`");

        let allow: Value = serde_json::from_str(&permission_reply("r7", true, &input)).unwrap();
        assert_eq!(allow["type"], "control_response");
        assert_eq!(allow["response"]["request_id"], "r7");
        assert_eq!(allow["response"]["response"]["behavior"], "allow");
        assert_eq!(allow["response"]["response"]["updatedInput"], input);
        let deny: Value = serde_json::from_str(&permission_reply("r7", false, &input)).unwrap();
        assert_eq!(deny["response"]["response"]["behavior"], "deny");
    }

    #[test]
    fn requests_read_as_what_they_would_do() {
        let input = |json: &str| serde_json::from_str::<Value>(json).unwrap();
        assert_eq!(
            summarize_request("Edit", &input(r#"{"file_path":"src/app.tsx"}"#)),
            "Edit src/app.tsx"
        );
        assert_eq!(
            summarize_request("WebFetch", &input(r#"{"url":"https://example.com"}"#)),
            "WebFetch https://example.com"
        );
        assert!(summarize_request("mcp__x__y", &input(r#"{"a":1}"#)).starts_with("Use mcp__x__y"));
        // Other traffic is not mistaken for a request.
        assert_eq!(
            read_event(r#"{"type":"control_response","response":{"subtype":"success"}}"#),
            Event::Other
        );
        assert_eq!(
            read_event(
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","name":"Read"}]}}"#
            ),
            Event::Tool("Read".into())
        );
    }

    #[test]
    fn the_prompt_travels_as_json_not_as_a_command_line() {
        let line = user_message("say \"hi\"\n& del *");
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["message"]["content"], "say \"hi\"\n& del *");
        assert!(!line.contains('\n'));
    }

    #[test]
    fn only_uuid_shaped_ids_reach_the_command_line() {
        assert!(valid_session_id("24f45911-f12e-4bfe-a250-7a2b7f9389bd"));
        assert!(!valid_session_id("--dangerously-skip-permissions"));
        assert!(!valid_session_id("a b"));
        assert!(!valid_session_id(""));
    }

    #[test]
    fn sessions_read_text_and_skip_everything_else() {
        let root = std::env::temp_dir().join(format!("relay-claude-{}", std::process::id()));
        let folder = root.join("projects").join("F--Code-Leaf");
        std::fs::create_dir_all(&folder).unwrap();
        let id = "0f3a9c00-0000-4000-8000-000000000001";
        let lines = [
            r#"{"type":"queue-operation","sessionId":"x"}"#,
            r#"{"type":"user","cwd":"F:\\Code\\Leaf","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","cwd":"F:\\Code\\Leaf","timestamp":"2026-10-26T10:00:00Z","message":{"role":"user","content":"Why is the probe failing?\nIt was fine yesterday."}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"tool_use","name":"Read"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"..."}]}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent"}]}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The token expired."}]}}"#,
            "not json",
        ];
        std::fs::write(folder.join(format!("{id}.jsonl")), lines.join("\n")).unwrap();

        let sessions = list_sessions_in(&root);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "Why is the probe failing?");
        assert_eq!(sessions[0].cwd, r"F:\Code\Leaf");

        let session = read_session_in(&root, id).unwrap();
        let said: Vec<_> = session
            .messages
            .iter()
            .map(|m| (m.role, m.text.as_str()))
            .collect();
        assert_eq!(
            said,
            [
                ("user", "Why is the probe failing?\nIt was fine yesterday."),
                ("assistant", "The token expired."),
            ]
        );
        assert!(read_session_in(&root, "../../etc").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Records what Claude asked and allows it.
    #[derive(Default)]
    struct Allowing {
        asked: Vec<PermissionRequest>,
        tools: Vec<String>,
    }

    impl Host for Allowing {
        fn progress(&mut self, tool: &str) {
            self.tools.push(tool.to_owned());
        }

        fn approve(&mut self, request: PermissionRequest) -> impl Future<Output = bool> + Send {
            self.asked.push(request);
            async { true }
        }
    }

    /// One real Claude Code turn: costs a model call, so it only runs when
    /// asked for (`cargo test live_ -- --ignored --nocapture`). Proves the
    /// can_use_tool request reaches the host and the allow reply lets the
    /// tool run.
    #[tokio::test]
    #[ignore = "runs a real, billed Claude Code turn"]
    async fn live_a_write_asks_and_runs_once_allowed() {
        let folder = std::env::temp_dir().join(format!("relay-claude-live-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let mut host = Allowing::default();
        let run = run(
            "Create a file named hello.txt in the current folder containing exactly: hi. Do nothing else.".into(),
            folder.to_string_lossy().into_owned(),
            None,
            &mut host,
        )
        .await;
        println!("asked: {:?}", host.asked);
        println!("tools: {:?}", host.tools);
        println!("run: {run:?}");
        let written = std::fs::read_to_string(folder.join("hello.txt"));
        let _ = std::fs::remove_dir_all(&folder);

        let run = run.unwrap();
        assert!(valid_session_id(&run.session_id));
        assert!(
            host.asked.iter().any(|r| r.tool == "Write"),
            "expected a Write permission request"
        );
        assert_eq!(written.unwrap().trim(), "hi");
    }
}
