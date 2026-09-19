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
use crate::events::{AppEvent, EventSink};
use crate::gmail::{self, GmailSettings, GmailState, GmailStatus, HttpGoogleApi, OsKeyStore};
use crate::jobs::{JobId, JobRegistry};
use crate::overlay;
use crate::vault::{
    self, NewVaultEntry, PasswordOptions, VaultEntrySummary, VaultState, VaultStatus,
};

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
    OpenVault,
    Quit,
}

#[tauri::command]
pub fn run_core_command(app: AppHandle, command: CoreCommand) -> Result<()> {
    match command {
        CoreCommand::OpenSettings => {
            overlay::show_main(&app)?;
            app.emit(AppEvent::OpenSettingsRequested);
            Ok(())
        }
        CoreCommand::OpenMain => overlay::show_main(&app),
        CoreCommand::HideHud => overlay::hide_hud(&app),
        CoreCommand::OpenVault => {
            overlay::show_main(&app)?;
            app.emit(AppEvent::OpenVaultRequested);
            Ok(())
        }
        CoreCommand::Quit => {
            app.exit(0);
            Ok(())
        }
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

/// Whether a vault has been created, and whether it is currently unlocked.
#[tauri::command]
pub fn vault_status(app: AppHandle, vault: tauri::State<VaultState>) -> Result<VaultStatus> {
    vault::status(&app, &vault)
}

/// Creates a new, empty vault protected by `master_password`. Fails if a
/// vault already exists — this is not how you change the master password.
#[tauri::command]
pub fn vault_create(
    app: AppHandle,
    vault: tauri::State<VaultState>,
    master_password: String,
) -> Result<()> {
    vault::create(&app, &vault, &master_password)
}

/// Decrypts the vault into memory. Fails with `WrongMasterPassword` if the
/// password does not match — there is no separate "check password" step.
#[tauri::command]
pub fn vault_unlock(
    app: AppHandle,
    vault: tauri::State<VaultState>,
    master_password: String,
) -> Result<()> {
    vault::unlock(&app, &vault, &master_password)
}

/// Drops the decrypted entries from memory. The file on disk is untouched.
#[tauri::command]
pub fn vault_lock(vault: tauri::State<VaultState>) -> Result<()> {
    vault::lock(&vault)
}

/// Generates a password from the given character-class options. Pure and
/// stateless — does not touch the vault, so it works before one exists.
#[tauri::command]
pub fn generate_password(options: PasswordOptions) -> Result<String> {
    vault::generate_password(&options)
}

/// Adds a new entry to the unlocked vault and persists it immediately.
#[tauri::command]
pub fn vault_add_entry(
    app: AppHandle,
    vault: tauri::State<VaultState>,
    entry: NewVaultEntry,
) -> Result<VaultEntrySummary> {
    vault::add_entry(&app, &vault, entry)
}

/// Lists every entry in the unlocked vault, without passwords.
#[tauri::command]
pub fn vault_list_entries(vault: tauri::State<VaultState>) -> Result<Vec<VaultEntrySummary>> {
    vault::list_entries(&vault)
}

/// Reveals one entry's password by id. The only command that returns a
/// stored secret in plaintext.
#[tauri::command]
pub fn vault_reveal_password(vault: tauri::State<VaultState>, id: String) -> Result<String> {
    vault::reveal_password(&vault, &id)
}

/// Removes an entry from the unlocked vault and persists the change.
#[tauri::command]
pub fn vault_delete_entry(
    app: AppHandle,
    vault: tauri::State<VaultState>,
    id: String,
) -> Result<()> {
    vault::delete_entry(&app, &vault, &id)
}

/// Writes an encrypted copy of the vault to the user's documents folder and
/// returns the path it was written to.
#[tauri::command]
pub fn vault_export(app: AppHandle, vault: tauri::State<VaultState>) -> Result<String> {
    vault::export(&app, &vault)
}

/// Whether Gmail is connected, mid-handshake, or neither.
#[tauri::command]
pub fn gmail_status(gmail: tauri::State<GmailState>) -> GmailStatus {
    gmail::status(&gmail)
}

#[tauri::command]
pub fn gmail_get_settings(gmail: tauri::State<GmailState>) -> GmailSettings {
    gmail::get_settings(&gmail)
}

#[tauri::command]
pub fn gmail_set_settings(
    app: AppHandle,
    gmail: tauri::State<GmailState>,
    settings: GmailSettings,
) -> Result<()> {
    gmail::set_settings(&app, &gmail, settings)
}

/// Opens the system browser to Google's consent screen and waits for the
/// loopback redirect; resolves once the account is connected and the polling
/// job has started, or rejects on cancellation, timeout, or a sign-in error.
#[tauri::command]
pub async fn gmail_connect(
    app: AppHandle,
    gmail: tauri::State<'_, GmailState>,
    jobs: tauri::State<'_, JobRegistry>,
) -> Result<String> {
    let registry = jobs.inner().clone();
    gmail::connect(
        app,
        gmail.inner(),
        registry,
        HttpGoogleApi::new(),
        OsKeyStore,
    )
    .await
}

/// Cancels an in-flight `gmail_connect` call — its still-pending `invoke`
/// promise rejects with `GmailAuthCancelled` once the loopback listener
/// notices.
#[tauri::command]
pub fn gmail_cancel_connect(gmail: tauri::State<GmailState>) -> Result<()> {
    gmail::cancel_connect(&gmail)
}

/// Stops the polling job, best-effort revokes the token with Google, and
/// deletes both the on-disk connector state and its OS keychain key.
#[tauri::command]
pub async fn gmail_disconnect(
    app: AppHandle,
    gmail: tauri::State<'_, GmailState>,
    jobs: tauri::State<'_, JobRegistry>,
) -> Result<()> {
    let registry = jobs.inner().clone();
    gmail::disconnect(
        &app,
        gmail.inner(),
        &registry,
        &HttpGoogleApi::new(),
        &OsKeyStore,
    )
    .await
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
