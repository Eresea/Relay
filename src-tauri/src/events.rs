//! Core → frontend push channel.
//!
//! Everything the core learns about while no window is asking — a job
//! finishing, a notification worth surfacing — crosses here rather than
//! through a command's return value. The frontend registers exactly one
//! listener (`core/tauri.ts`) and dispatches on `type`, so a new event never
//! needs new frontend plumbing to arrive.

use serde::Serialize;

use crate::jobs::JobId;

/// The name every event is emitted under. One channel, not one per event
/// type, so the frontend's subscription surface never grows.
pub const CHANNEL: &str = "relay://event";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AppEvent {
    /// The set of core-contributed palette commands changed and should be
    /// re-fetched. Nothing emits this yet — `core_commands()` is static —
    /// but a per-project command set will need it.
    #[allow(dead_code, reason = "wire-format variant with no producer yet")]
    CommandsChanged,

    /// The "Open settings" command was run. `Home` listens for this to switch
    /// its own view — a plain `show_main` cannot do that by itself, since the
    /// palette that dispatched the command and the main window that must
    /// react to it are separate webviews with no shared JS state.
    OpenSettingsRequested,

    /// A notification to show in the HUD. `hue_source` names the long-lived
    /// object this is about (a job id today, an agent id once agents exist)
    /// — the HUD hashes it to a colour, never the notification's own id,
    /// so an agent's colour stays the same across every job it runs.
    Notification {
        #[serde(rename = "jobId")]
        job_id: JobId,
        #[serde(rename = "hueSource")]
        hue_source: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
        status: NotificationStatus,
        /// None hides the progress track — never synthesise a percentage.
        #[serde(skip_serializing_if = "Option::is_none")]
        progress: Option<u8>,
    },

    /// The job behind a notification finished. Separate from `Notification`
    /// so the frontend can hold the last real content on screen for a grace
    /// period rather than have it vanish the instant work completes.
    NotificationDone {
        #[serde(rename = "jobId")]
        job_id: JobId,
        ok: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    dead_code,
    reason = "constructed only by AppEvent::Notification, which has no producer right now"
)]
pub enum NotificationStatus {
    Running,
    Waiting,
    Blocked,
    Done,
}

/// Where an `AppEvent` goes. `AppHandle` is the real implementation; a job's
/// logic is written against this trait instead, so it can be exercised with
/// a plain collector in tests, without a running Tauri app.
pub trait EventSink: Clone + Send + Sync + 'static {
    fn emit(&self, event: AppEvent);
}

impl EventSink for tauri::AppHandle {
    fn emit(&self, event: AppEvent) {
        // The HUD window is created hidden and nothing else ever shows it, so
        // without this a notification renders into a window the user never
        // sees — the whole pipeline runs correctly and silently. Bring it on
        // screen before emitting the event that fills it.
        if matches!(event, AppEvent::Notification { .. }) {
            if let Err(error) = crate::overlay::show_hud(self) {
                log::error!("could not show the HUD: {error}");
            }
        }

        if let Err(error) = tauri::Emitter::emit(self, CHANNEL, &event) {
            log::error!("failed to emit an app event: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_wire_shape_is_camel_case() {
        let event = AppEvent::Notification {
            job_id: JobId::from("job-1".to_string()),
            hue_source: "relay-demo".to_string(),
            title: "Doing the thing".to_string(),
            detail: None,
            icon: None,
            status: NotificationStatus::Running,
            progress: Some(45),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(
            json,
            r#"{"type":"notification","jobId":"job-1","hueSource":"relay-demo","title":"Doing the thing","status":"running","progress":45}"#
        );
    }

    #[test]
    fn commands_changed_is_a_bare_tag() {
        let json = serde_json::to_string(&AppEvent::CommandsChanged).unwrap();
        assert_eq!(json, r#"{"type":"commandsChanged"}"#);
    }

    #[test]
    fn open_settings_requested_is_a_bare_tag() {
        let json = serde_json::to_string(&AppEvent::OpenSettingsRequested).unwrap();
        assert_eq!(json, r#"{"type":"openSettingsRequested"}"#);
    }

    #[test]
    fn notification_done_wire_shape() {
        let json = serde_json::to_string(&AppEvent::NotificationDone {
            job_id: JobId::from("job-2".to_string()),
            ok: false,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"notificationDone","jobId":"job-2","ok":false}"#
        );
    }
}
