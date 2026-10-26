//! Claude Code, driven headless.
//!
//! A turn is one `claude -p --output-format json` run in a workspace, the
//! prompt written to its stdin so no shell ever parses it, and `--resume`
//! continuing a session. Headless Claude Code declines any tool that needs
//! approval, so from Relay it can read a workspace but not change it.
//!
//! Sessions are read from Claude Code's own transcripts
//! (`~/.claude/projects/<folder>/<session>.jsonl`). That format is internal
//! to Claude Code, so parsing takes only what it recognises — ids, the
//! working folder, plain text — and skips everything else.

use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;
use tokio::{io::AsyncWriteExt, process::Command};

use crate::error::{Error, Result};

const TURN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_PROMPT_LENGTH: usize = 64_000;
const SESSION_LIMIT: usize = 50;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRun {
    pub session_id: String,
    pub response: String,
    pub cost_usd: Option<f64>,
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

/// Runs one turn in `working_directory`, new or resuming `session_id`.
pub async fn send(
    prompt: String,
    working_directory: String,
    session_id: Option<String>,
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
    command.args(["-p", "--output-format", "json"]);
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
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| claude_error("Claude Code input is unavailable"))?;
    stdin.write_all(prompt.as_bytes()).await?;
    drop(stdin);

    let output = tokio::time::timeout(TURN_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| claude_error("Claude Code took longer than 15 minutes"))??;
    parse_result(&output.stdout).map_err(|error| {
        // No result at all: the CLI failed before a turn began; stderr says why.
        let stderr = String::from_utf8_lossy(&output.stderr);
        match stderr.lines().find(|line| !line.trim().is_empty()) {
            Some(line) if output.stdout.trim_ascii().is_empty() => claude_error(line.trim()),
            _ => error,
        }
    })
}

/// Reads the single result object `--output-format json` prints.
fn parse_result(stdout: &[u8]) -> Result<ClaudeRun> {
    let value: Value = serde_json::from_slice(stdout)
        .map_err(|_| claude_error("Claude Code returned no result"))?;
    let text = value.get("result").and_then(Value::as_str).unwrap_or("");
    if value.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(claude_error(if text.is_empty() {
            "Claude Code could not finish the turn"
        } else {
            text
        }));
    }
    let session_id = value
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or_else(|| claude_error("Claude Code returned no session"))?;
    Ok(ClaudeRun {
        session_id: session_id.to_owned(),
        response: text.to_owned(),
        cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
    })
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
        let run = parse_result(
            br#"{"type":"result","subtype":"success","is_error":false,"result":"Hi","session_id":"0f3a-9c","total_cost_usd":0.012}"#,
        )
        .unwrap();
        assert_eq!(
            run,
            ClaudeRun {
                session_id: "0f3a-9c".into(),
                response: "Hi".into(),
                cost_usd: Some(0.012),
            }
        );
    }

    #[test]
    fn an_error_result_says_why() {
        let error =
            parse_result(br#"{"is_error":true,"result":"Credit balance is too low"}"#).unwrap_err();
        assert_eq!(error.to_string(), "Credit balance is too low");
        assert!(parse_result(b"not json").is_err());
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
}
