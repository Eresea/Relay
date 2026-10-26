//! Terminal sessions: real shells in pseudo-terminals, streamed to the
//! interface.
//!
//! Each session is a shell started in a PTY (ConPTY on Windows) through
//! `portable-pty`. Output is read on a thread of its own and sent over the
//! IPC channel the webview opened the session with, as UTF-8 text; keystrokes
//! come back through `terminal_write`. The interface draws the screen
//! (xterm.js); the core never interprets terminal bytes. That includes
//! ConPTY's opening cursor-position query (`ESC[6n`), which it waits on
//! before running anything: xterm.js answers it like any terminal does.
//!
//! A second thread waits for the shell to exit. On Windows a ConPTY reader
//! only sees end-of-file once the pseudo-terminal itself closes, so the
//! waiter closes it, lets the reader drain, and only then reports the exit,
//! so the last output always arrives before it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalOutput {
    Data { data: String },
    Exit { code: Option<u32> },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: u32,
    pub shell: String,
    pub cwd: String,
}

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Every open session, by id. Dropping a session closes its pseudo-terminal,
/// which ends its shell.
#[derive(Clone, Default)]
pub struct Terminals(Arc<Inner>);

#[derive(Default)]
struct Inner {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
}

fn pty_error(error: impl std::fmt::Display) -> Error {
    std::io::Error::other(format!("Terminal: {error}")).into()
}

/// Takes the longest valid UTF-8 prefix of `pending`, keeping a multi-byte
/// character split across two reads for the next one. Invalid bytes become
/// U+FFFD rather than stalling the stream.
fn take_text(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(text) => {
            let text = text.to_owned();
            pending.clear();
            text
        }
        Err(error) if error.error_len().is_none() => {
            // An incomplete character at the end: keep it for the next read.
            let valid = error.valid_up_to();
            let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            text
        }
        Err(_) => {
            let text = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            text
        }
    }
}

/// The shell a new session runs: PowerShell 7 if installed, else Windows
/// PowerShell; `$SHELL` elsewhere.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        let on_path = std::env::var_os("PATH").is_some_and(|path| {
            std::env::split_paths(&path).any(|dir| dir.join("pwsh.exe").is_file())
        });
        if on_path {
            "pwsh.exe"
        } else {
            "powershell.exe"
        }
        .to_owned()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_owned())
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map_or_else(|| PathBuf::from("."), PathBuf::from)
}

impl Terminals {
    /// Starts `program` with `args` in `cwd` and streams its output to
    /// `on_output` until it exits. Returns the session's id.
    pub fn open(
        &self,
        program: &str,
        args: &[&str],
        cwd: &Path,
        cols: u16,
        rows: u16,
        on_output: impl Fn(TerminalOutput) + Send + Sync + 'static,
    ) -> Result<u32> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(pty_error)?;
        let mut command = CommandBuilder::new(program);
        command.args(args);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).map_err(pty_error)?;
        // The child holds the only copy it needs; ours would keep the PTY open.
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(pty_error)?;
        let writer = pair.master.take_writer().map_err(pty_error)?;

        let id = self.0.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.0.sessions.lock().unwrap().insert(
            id,
            Session {
                writer,
                master: pair.master,
                killer: child.clone_killer(),
            },
        );

        let on_output = Arc::new(on_output);
        let send = Arc::clone(&on_output);
        let reading = std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut pending = Vec::new();
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                pending.extend_from_slice(&buffer[..read]);
                let data = take_text(&mut pending);
                if !data.is_empty() {
                    send(TerminalOutput::Data { data });
                }
            }
        });

        let inner = Arc::clone(&self.0);
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            // Closing the PTY ends the reader, even on Windows.
            inner.sessions.lock().unwrap().remove(&id);
            let _ = reading.join();
            on_output(TerminalOutput::Exit { code });
        });
        Ok(id)
    }

    fn with<T>(&self, id: u32, work: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
        let mut sessions = self.0.sessions.lock().unwrap();
        let session = sessions
            .get_mut(&id)
            .ok_or_else(|| pty_error("that session has ended"))?;
        work(session)
    }

    /// Sends keystrokes (or pasted text) to the session's shell.
    pub fn write(&self, id: u32, data: &str) -> Result<()> {
        self.with(id, |session| {
            session.writer.write_all(data.as_bytes())?;
            session.writer.flush()?;
            Ok(())
        })
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<()> {
        self.with(id, |session| {
            session
                .master
                .resize(PtySize {
                    rows: rows.max(1),
                    cols: cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(pty_error)
        })
    }

    /// Ends the session's shell. Its exit still arrives as output.
    pub fn close(&self, id: u32) -> Result<()> {
        let session = self.0.sessions.lock().unwrap().remove(&id);
        if let Some(mut session) = session {
            let _ = session.killer.kill();
        }
        Ok(())
    }
}

/// Opens a session in `cwd` (home when absent) running the default shell.
#[tauri::command]
pub fn terminal_open(
    terminals: tauri::State<Terminals>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel<TerminalOutput>,
) -> Result<TerminalInfo> {
    let cwd = cwd.map_or_else(home_dir, PathBuf::from);
    if !cwd.is_dir() {
        return Err(pty_error(format!("{} is not a folder", cwd.display())));
    }
    let shell = default_shell();
    let id = terminals.open(&shell, &[], &cwd, cols, rows, move |output| {
        let _ = on_output.send(output);
    })?;
    Ok(TerminalInfo {
        id,
        shell,
        cwd: cwd.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn terminal_write(terminals: tauri::State<Terminals>, id: u32, data: String) -> Result<()> {
    terminals.write(id, &data)
}

#[tauri::command]
pub fn terminal_resize(
    terminals: tauri::State<Terminals>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<()> {
    terminals.resize(id, cols, rows)
}

#[tauri::command]
pub fn terminal_close(terminals: tauri::State<Terminals>, id: u32) -> Result<()> {
    terminals.close(id)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    #[test]
    fn split_characters_wait_for_their_second_half() {
        let mut pending = "é".as_bytes()[..1].to_vec();
        assert_eq!(take_text(&mut pending), "");
        pending.extend_from_slice(&"é".as_bytes()[1..]);
        pending.extend_from_slice(b"!");
        assert_eq!(take_text(&mut pending), "é!");
        assert!(pending.is_empty());

        let mut broken = vec![b'a', 0xff, b'b'];
        assert_eq!(take_text(&mut broken), "a\u{fffd}b");
    }

    /// Runs one real command in a pseudo-terminal and waits for its exit.
    fn run(program: &str, args: &[&str]) -> (String, Option<u32>, Terminals) {
        let terminals = Terminals::default();
        let (sender, outputs) = mpsc::channel();
        let sender = Mutex::new(sender);
        let id = terminals
            .open(
                program,
                args,
                &std::env::temp_dir(),
                80,
                24,
                move |output| {
                    let _ = sender.lock().unwrap().send(output);
                },
            )
            .unwrap();
        let mut text = String::new();
        loop {
            let Ok(next) = outputs.recv_timeout(Duration::from_secs(20)) else {
                panic!("no exit after {text:?}");
            };
            match next {
                TerminalOutput::Data { data } => {
                    // ConPTY asks where the cursor is and waits for the
                    // answer; xterm.js gives it in the app, the test here.
                    if data.contains("[6n") {
                        terminals.write(id, "[1;1R").unwrap();
                    }
                    text.push_str(&data);
                }
                TerminalOutput::Exit { code } => return (text, code, terminals),
            }
        }
    }

    #[test]
    fn a_command_streams_its_output_then_its_exit() {
        #[cfg(windows)]
        let (text, code, terminals) = run("cmd.exe", &["/c", "echo relay-pty"]);
        #[cfg(not(windows))]
        let (text, code, terminals) = run("/bin/sh", &["-c", "echo relay-pty"]);
        assert!(text.contains("relay-pty"), "output was {text:?}");
        assert_eq!(code, Some(0));
        // The session is gone once its shell exits.
        assert!(terminals.write(1, "x").is_err());
    }
}
