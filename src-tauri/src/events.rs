//! Core → frontend push channel.
//!
//! Everything the core learns about while no window is asking — a job
//! finishing, a notification worth surfacing — crosses here rather than
//! through a command's return value. The frontend registers exactly one
//! listener (`core/tauri.ts`) and dispatches on `type`, so a new event never
//! needs new frontend plumbing to arrive.

use serde::{Deserialize, Serialize};

use crate::jobs::JobId;

/// The name every event is emitted under. One channel, not one per event
/// type, so the frontend's subscription surface never grows.
pub const CHANNEL: &str = "relay://event";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    not(desktop),
    allow(
        dead_code,
        reason = "desktop updater wire shape is shared with the frontend"
    )
)]
pub enum UpdateState {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub state: UpdateState,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for UpdateSnapshot {
    fn default() -> Self {
        Self {
            state: UpdateState::Idle,
            current_version: env!("CARGO_PKG_VERSION").to_owned(),
            version: None,
            notes: None,
            downloaded_bytes: 0,
            content_length: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[cfg_attr(
    not(desktop),
    allow(
        dead_code,
        reason = "desktop updater wire shape is shared with the frontend"
    )
)]
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

    /// The "Password vault" command was run. Mirrors `OpenSettingsRequested`
    /// for the same reason: the palette that dispatched the command and the
    /// main window that must switch views are separate webviews.
    OpenVaultRequested,

    /// The "GitHub" command was run. Mirrors `OpenVaultRequested` for the
    /// same reason: the palette that dispatched the command and the main
    /// window that must switch views are separate webviews.
    OpenGithubRequested,

    /// A notification to show in the HUD. `hue_source` names the long-lived
    /// object this is about (a job id today, an agent id once agents exist)
    /// — the HUD hashes it to a colour, never the notification's own id,
    /// so an agent's colour stays the same across every job it runs.
    Notification {
        #[serde(rename = "notificationId")]
        notification_id: String,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        auto_dismiss_ms: Option<u64>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        actions: Vec<NotificationAction>,
    },

    /// The job behind a notification finished. Separate from `Notification`
    /// so the frontend can hold the last real content on screen for a grace
    /// period rather than have it vanish the instant work completes.
    NotificationDone {
        #[serde(rename = "jobId")]
        job_id: JobId,
        ok: bool,
    },

    /// Persistent update state for the main window's status strip.
    UpdateChanged {
        #[serde(flatten)]
        snapshot: UpdateSnapshot,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "id", rename_all = "camelCase")]
pub enum NotificationAction {
    Open { label: String, url: String },
    Cancel { label: String },
}

pub const INFO_AUTO_DISMISS_MS: u64 = 8_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationStatus {
    /// No current producer reports this mid-flight: the GitHub connector's
    /// device-flow wait is `Waiting` (blocked on the user, not doing work),
    /// and its poll cycles report a single `Done` per notification rather
    /// than a visible in-progress phase, since popping the HUD open every
    /// poll tick even when nothing changed would be exactly the kind of
    /// noise Umbra's "state what is true and what it costs" rule warns
    /// against. Kept for the producer that actually has visible progress to
    /// report — a file transfer, a multi-step build.
    #[allow(dead_code, reason = "no current producer reports mid-flight progress")]
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
        if let Err(error) = crate::notifications::persist(self, &event) {
            log::error!("failed to persist notification: {error}");
        }

        #[cfg(mobile)]
        show_mobile_notification(self, &event);

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

#[cfg(mobile)]
fn show_mobile_notification(app: &tauri::AppHandle, event: &AppEvent) {
    use tauri_plugin_notification::NotificationExt;

    let AppEvent::Notification {
        notification_id,
        title,
        detail,
        actions,
        ..
    } = event
    else {
        return;
    };

    let mut builder = app
        .notification()
        .builder()
        .id(native_notification_id(notification_id))
        .channel_id("relay-events")
        .title(title)
        .action_type_id("relay-notification")
        .extra("notificationId", notification_id)
        .auto_cancel();

    if let Some(detail) = detail {
        builder = builder.body(detail);
    }
    if let Some(url) = actions.iter().find_map(|action| match action {
        NotificationAction::Open { url, .. } => Some(url),
        NotificationAction::Cancel { .. } => None,
    }) {
        builder = builder.extra("openUrl", url);
    }

    if let Err(error) = builder.show() {
        log::error!("failed to show mobile notification: {error}");
    }
}

#[cfg(mobile)]
fn native_notification_id(value: &str) -> i32 {
    let mut hash = 0x811c9dc5u32;
    for byte in value.bytes() {
        hash = (hash ^ u32::from(byte)).wrapping_mul(0x01000193);
    }
    let id = (hash & 0x7fff_ffff) as i32;
    if id == 0 {
        1
    } else {
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_wire_shape_is_camel_case() {
        let event = AppEvent::Notification {
            notification_id: "job-1".to_string(),
            job_id: JobId::from("job-1".to_string()),
            hue_source: "relay-demo".to_string(),
            title: "Doing the thing".to_string(),
            detail: None,
            icon: None,
            status: NotificationStatus::Running,
            progress: Some(45),
            auto_dismiss_ms: None,
            actions: Vec::new(),
        };

        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(
            json,
            r#"{"type":"notification","notificationId":"job-1","jobId":"job-1","hueSource":"relay-demo","title":"Doing the thing","status":"running","progress":45}"#
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
    fn open_vault_requested_is_a_bare_tag() {
        let json = serde_json::to_string(&AppEvent::OpenVaultRequested).unwrap();
        assert_eq!(json, r#"{"type":"openVaultRequested"}"#);
    }

    #[test]
    fn open_github_requested_is_a_bare_tag() {
        let json = serde_json::to_string(&AppEvent::OpenGithubRequested).unwrap();
        assert_eq!(json, r#"{"type":"openGithubRequested"}"#);
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

    #[test]
    fn update_changed_wire_shape() {
        let json = serde_json::to_string(&AppEvent::UpdateChanged {
            snapshot: UpdateSnapshot {
                state: UpdateState::Downloading,
                current_version: "0.1.0".to_string(),
                version: Some("0.2.0".to_string()),
                notes: None,
                downloaded_bytes: 50,
                content_length: Some(100),
                error: None,
            },
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"updateChanged","state":"downloading","currentVersion":"0.1.0","version":"0.2.0","downloadedBytes":50,"contentLength":100}"#
        );
    }

    #[cfg(mobile)]
    #[test]
    fn native_notification_ids_are_positive_and_stable() {
        let first = native_notification_id("notification-1");
        assert!(first > 0);
        assert_eq!(first, native_notification_id("notification-1"));
        assert_ne!(first, native_notification_id("notification-2"));
    }
}
