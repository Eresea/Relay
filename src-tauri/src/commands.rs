//! The IPC surface.
//!
//! Anything the frontend can ask the core to do is listed here, and nowhere
//! else. Keeping the surface small and explicit is what lets the capability
//! files stay honest.
//!
//! Two shapes coexist deliberately. `CoreCommand` is an adjacently tagged
//! enum — wire shape `{ "id": "...", "args": ... }` — so the exact JSON the
//! palette already sent (id + args) now round-trips through serde instead of
//! a hand-rolled match on a bare string. There is no longer a way to add an
//! argument and have it silently dropped: a variant that needs data declares
//! fields, and the compiler requires every arm to handle them.
//! `CoreCommandMeta` is separate and descriptive only — what the palette
//! displays for a core-contributed row — so the dispatch enum's shape can
//! change without touching how a command is presented.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::Result;
use crate::jobs::{self, JobId, JobRegistry};
use crate::overlay;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandMeta {
    pub id: String,
    pub title: String,
    pub group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

impl CoreCommandMeta {
    fn new(id: &str, title: &str, group: &str, icon: &str) -> Self {
        Self {
            id: id.to_owned(),
            title: title.to_owned(),
            group: group.to_owned(),
            hint: None,
            icon: Some(icon.to_owned()),
        }
    }
}

#[tauri::command]
pub fn core_commands() -> Vec<CoreCommandMeta> {
    vec![
        CoreCommandMeta::new("open_main", "Open Relay window", "Relay", "panel-left"),
        CoreCommandMeta::new("hide_hud", "Dismiss status overlay", "Relay", "eye"),
        CoreCommandMeta::new("scan_home", "Scan home folder", "Relay", "folder"),
    ]
}

/// What the palette can ask the core to do. Adjacently tagged so the wire
/// shape is exactly `{ "id": "open_settings" }` or, for a variant that
/// carries data, `{ "id": "...", "args": { ... } }`.
#[derive(Debug, Deserialize)]
#[serde(tag = "id", content = "args", rename_all = "snake_case")]
pub enum CoreCommand {
    OpenSettings,
    OpenMain,
    HideHud,
    Quit,
    /// Walks the home directory in the background, reporting progress
    /// through the job/event pipeline. See `jobs::scan`.
    ScanHome,
}

#[tauri::command]
pub fn run_core_command(
    app: AppHandle,
    jobs: tauri::State<JobRegistry>,
    command: CoreCommand,
) -> Result<()> {
    match command {
        CoreCommand::OpenSettings => overlay::show_main(&app),
        CoreCommand::OpenMain => overlay::show_main(&app),
        CoreCommand::HideHud => overlay::hide_hud(&app),
        CoreCommand::Quit => {
            app.exit(0);
            Ok(())
        }
        CoreCommand::ScanHome => jobs::scan::start(app, jobs.inner().clone()),
    }
}

/// Requests cooperative cancellation of a running job. See
/// `jobs::JobContext::checkpoint` for what "cooperative" means in practice.
#[tauri::command]
pub fn cancel_job(jobs: tauri::State<JobRegistry>, job_id: JobId) -> Result<()> {
    jobs.cancel(&job_id)
}

/// A pull-based check alongside the push-based `AppEvent::NotificationDone` —
/// for the case where the frontend asks about a job after missing the event
/// that would have told it (a window that was not open yet, for instance).
#[tauri::command]
pub fn is_job_running(jobs: tauri::State<JobRegistry>, job_id: JobId) -> bool {
    jobs.is_running(&job_id)
}

#[tauri::command]
pub fn dismiss_palette(app: AppHandle) -> Result<()> {
    overlay::hide_palette(&app)
}

#[tauri::command]
pub fn toggle_palette(app: AppHandle) -> Result<()> {
    overlay::toggle_palette(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_variant_deserializes_from_bare_id() {
        let command: CoreCommand = serde_json::from_str(r#"{"id":"quit"}"#).unwrap();
        assert!(matches!(command, CoreCommand::Quit));
    }

    #[test]
    fn unknown_id_is_rejected() {
        let result: std::result::Result<CoreCommand, _> = serde_json::from_str(r#"{"id":"nope"}"#);
        assert!(result.is_err());
    }

    #[test]
    fn core_commands_ids_match_the_dispatch_enum() {
        // The palette displays these ids without knowing CoreCommand exists;
        // if they drift apart, a listed command silently fails to run. Every
        // metadata id must round-trip through the real dispatch enum.
        for meta in core_commands() {
            let wire = format!(r#"{{"id":"{}"}}"#, meta.id);
            let parsed: std::result::Result<CoreCommand, _> = serde_json::from_str(&wire);
            assert!(
                parsed.is_ok(),
                "core_commands() id `{}` is not a valid CoreCommand",
                meta.id
            );
        }
    }
}
