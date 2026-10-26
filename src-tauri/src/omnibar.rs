//! Work the Omnibar starts and lets go of.
//!
//! A Codex turn or an `npm run` can take minutes. Awaiting either from the
//! Omnibar would hold a spotlight window open with nothing to show, so both
//! run as jobs instead: the Omnibar closes at once, and progress, the answer
//! or the failure arrive through the attention pill and stack.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::claude;
use crate::codex;
use crate::error::{Error, Result};
use crate::events::{EventSink, NotificationAction, NotificationStatus};
use crate::jobs::{self, JobContext, JobId, JobRegistry, NotificationOptions};
use crate::workspaces::{self, WorkspaceAction};

/// An answer is worth more than "done": keep it on screen long enough to read.
const ANSWER_READ_MS: u64 = 30_000;

/// Sends `prompt` to Codex in `working_directory` as a new thread.
pub fn ask_codex<S: EventSink>(
    sink: S,
    registry: JobRegistry,
    prompt: String,
    working_directory: String,
) -> JobId {
    jobs::spawn(sink, registry, "codex", move |ctx| async move {
        let title = format!("Codex · {}", clip(&prompt, 60));
        let place = folder_name(&working_directory);
        ctx.report(
            NotificationStatus::Running,
            title.clone(),
            Some(format!("Working in {place}")),
            None,
        );
        match codex::send(prompt, working_directory, None).await {
            Ok(run) => {
                ctx.report_notification(
                    NotificationStatus::Done,
                    title,
                    Some(clip(&first_line(&run.response), 160)),
                    None,
                    NotificationOptions {
                        notification_id: ctx.id().to_string(),
                        auto_dismiss_ms: Some(ANSWER_READ_MS),
                        actions: vec![NotificationAction::Open {
                            label: "Open thread".to_owned(),
                            url: format!("codex://threads/{}", run.thread_id),
                        }],
                    },
                );
                Ok(())
            }
            Err(error) => fail(&ctx, title, error),
        }
    })
}

/// Sends `prompt` to Claude Code in `working_directory` as a new session.
pub fn ask_claude<S: EventSink>(
    sink: S,
    registry: JobRegistry,
    prompt: String,
    working_directory: String,
) -> JobId {
    jobs::spawn(sink, registry, "claude", move |ctx| async move {
        let title = format!("Claude · {}", clip(&prompt, 60));
        let place = folder_name(&working_directory);
        ctx.report(
            NotificationStatus::Running,
            title.clone(),
            Some(format!("Working in {place}")),
            None,
        );
        match claude::send(prompt, working_directory, None).await {
            Ok(run) => {
                ctx.report_notification(
                    NotificationStatus::Done,
                    title,
                    Some(clip(&first_line(&run.response), 160)),
                    None,
                    NotificationOptions {
                        notification_id: ctx.id().to_string(),
                        auto_dismiss_ms: Some(ANSWER_READ_MS),
                        // Relay's own link: the interface opens the session in its Claude tab.
                        actions: vec![NotificationAction::Open {
                            label: "Open session".to_owned(),
                            url: format!("relay://claude/{}", run.session_id),
                        }],
                    },
                );
                Ok(())
            }
            Err(error) => fail(&ctx, title, error),
        }
    })
}

/// Runs a `package.json` script in a local workspace.
pub fn run_script<S: EventSink>(
    sink: S,
    registry: JobRegistry,
    path: String,
    script: String,
) -> JobId {
    // Hue by workspace, so a project's jobs share its colour in every list.
    jobs::spawn(sink, registry, path.clone(), move |ctx| async move {
        let title = format!("{script} · {}", folder_name(&path));
        ctx.report(
            NotificationStatus::Running,
            title.clone(),
            Some(format!("npm run {script}")),
            None,
        );
        let started = Instant::now();
        let result = tauri::async_runtime::spawn_blocking(move || {
            workspaces::run_action(&path, WorkspaceAction::RunScript { script })
        })
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?;
        match result {
            Ok(()) => {
                let took = elapsed(started.elapsed());
                ctx.report(
                    NotificationStatus::Done,
                    title,
                    Some(format!("Finished in {took}")),
                    None,
                );
                Ok(())
            }
            Err(error) => fail(&ctx, title, error),
        }
    })
}

/// The job runner only learns that a job failed, not why. Say why first.
fn fail<S: EventSink>(ctx: &JobContext<S>, title: String, error: Error) -> Result<()> {
    ctx.report(
        NotificationStatus::Blocked,
        title,
        Some(error.to_string()),
        None,
    );
    Err(error)
}

fn folder_name(path: &str) -> String {
    Path::new(path).file_name().map_or_else(
        || path.to_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// The first line with words in it, without Markdown heading, list or
/// emphasis marks.
fn first_line(text: &str) -> String {
    text.lines()
        .map(|line| {
            line.trim()
                .trim_start_matches(['#', '-', '>', ' '])
                .replace(['*', '`'], "")
        })
        .find(|line| !line.is_empty())
        .unwrap_or_else(|| "Answered".to_owned())
}

fn clip(text: &str, max_chars: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max_chars {
        return text;
    }
    let cut: String = text.chars().take(max_chars - 1).collect();
    format!("{}…", cut.trim_end())
}

fn elapsed(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {}s", seconds / 60, seconds % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::AppEvent;
    use crate::jobs::fake::FakeSink;

    #[test]
    fn clips_on_characters_and_collapses_whitespace() {
        assert_eq!(clip("fix the\n  vault", 60), "fix the vault");
        assert_eq!(clip("éééééééééé", 5), "éééé…");
    }

    #[test]
    fn first_line_skips_blank_lines_and_markdown_marks() {
        assert_eq!(first_line("\n## Summary\nTwo tests added."), "Summary");
        assert_eq!(first_line("- **Done** in `vault.rs`"), "Done in vault.rs");
        assert_eq!(first_line("   \n"), "Answered");
    }

    #[test]
    fn elapsed_is_specific() {
        assert_eq!(elapsed(Duration::from_secs(38)), "38s");
        assert_eq!(elapsed(Duration::from_secs(252)), "4m 12s");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failing_script_says_why_before_the_job_fails() {
        let sink = FakeSink::default();
        let registry = JobRegistry::default();
        let folder = std::env::temp_dir().to_string_lossy().into_owned();

        let id = run_script(sink.clone(), registry.clone(), folder, "nope".to_owned());
        for _ in 0..200 {
            if !registry.is_running(&id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;

        let events = sink.events();
        let statuses: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                AppEvent::Notification { status, detail, .. } => {
                    Some((format!("{status:?}"), detail.clone()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(statuses[0].0, "Running");
        assert_eq!(statuses[1].0, "Blocked");
        assert!(statuses[1]
            .1
            .as_deref()
            .is_some_and(|detail| detail.contains("not a Git clone")));
        assert!(events
            .iter()
            .any(|event| matches!(event, AppEvent::NotificationDone { ok: false, .. })));
    }
}
