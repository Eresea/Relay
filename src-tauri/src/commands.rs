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
#[cfg(desktop)]
use crate::events::UpdateSnapshot;
use crate::events::{AppEvent, EventSink};
use crate::github::{
    self, client::HttpGitHubClient, client::RepositorySummary, oauth::DeviceAuthorization,
    poll::PullRequestSnapshot, GithubStatus,
};
use crate::gmail::{self, GmailSettings, GmailState, GmailStatus, HttpGoogleApi, OsKeyStore};
use crate::jobs::{JobId, JobRegistry};
use crate::linear::{
    self, Initiative, InitiativeProject, InitiativeUpdate, Issue, IssueDetail, IssuePage,
    IssueRelation, LinearCodexContext, LinearComment, LinearConnection, LinearCycle, LinearLabel,
    LinearMilestone, LinearProject, LinearProjectStatus, LinearProjectUpdate, Person, Team,
    WorkflowState,
};
#[cfg(mobile)]
use crate::mobile_updates;
use crate::nexus_auth;
use crate::notifications::NotificationRecord;
use crate::overlay;
#[cfg(desktop)]
use crate::updates::UpdateManager;
use crate::vault::{
    self, NewVaultEntry, PasswordOptions, VaultEntrySummary, VaultState, VaultStatus,
};
use crate::workspaces::{WorkspaceAction, WorkspaceSummary};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommandMeta {
    pub id: String,
    pub title: String,
    pub group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

impl CoreCommandMeta {
    fn new(id: &str, title: &str, group: &str, icon: &str) -> Self {
        Self {
            id: id.to_owned(),
            title: title.to_owned(),
            group: group.to_owned(),
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
    OpenGithub,
    OpenLinear,
    OpenRuntime,
    OpenAgents,
    OpenAgentThread(OpenAgentThreadArgs),
    Quit,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAgentThreadArgs {
    thread_id: String,
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
        CoreCommand::OpenGithub => {
            overlay::show_main(&app)?;
            app.emit(AppEvent::OpenGithubRequested);
            Ok(())
        }
        CoreCommand::OpenLinear => {
            overlay::show_main(&app)?;
            app.emit(AppEvent::OpenLinearRequested);
            Ok(())
        }
        CoreCommand::OpenRuntime => {
            overlay::show_main(&app)?;
            app.emit(AppEvent::OpenRuntimeRequested);
            Ok(())
        }
        CoreCommand::OpenAgents => {
            overlay::show_main(&app)?;
            app.emit(AppEvent::OpenAgentsRequested);
            Ok(())
        }
        CoreCommand::OpenAgentThread(args) => {
            if args.thread_id.trim().is_empty() {
                return Err(std::io::Error::other("Thread ID cannot be empty").into());
            }
            overlay::show_main(&app)?;
            app.emit(AppEvent::OpenAgentThreadRequested {
                thread_id: args.thread_id,
            });
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

/// Whether a GitHub account is connected. Only reads the keychain — never
/// calls GitHub.
#[tauri::command]
pub async fn github_status(app: AppHandle) -> Result<GithubStatus> {
    github::status(&app).await
}

#[tauri::command]
pub async fn github_repositories(
    app: AppHandle,
    client: tauri::State<'_, HttpGitHubClient>,
) -> Result<Vec<RepositorySummary>> {
    github::repositories(&app, client.inner().clone()).await
}

#[tauri::command]
pub async fn github_register_webhooks(
    app: AppHandle,
    repositories: Vec<String>,
) -> Result<Vec<String>> {
    github::events::register(&app, repositories).await
}

#[tauri::command]
pub fn github_webhook_repositories(app: AppHandle) -> Result<Vec<String>> {
    github::events::registered_repositories(&app)
}

#[tauri::command]
pub async fn github_unregister_webhook(app: AppHandle, repository: String) -> Result<()> {
    github::events::unregister(&app, &repository).await
}

#[tauri::command]
pub fn github_pull_requests(
    app: AppHandle,
    include_closed: Option<bool>,
) -> Result<Vec<PullRequestSnapshot>> {
    github::pull_requests(&app, include_closed.unwrap_or(false))
}

/// Starts a Device Flow login and returns the code to show the user. The
/// wait for their approval continues in a background job — see
/// `github::connect_start`.
#[tauri::command]
pub fn github_connect_start(
    app: AppHandle,
    client: tauri::State<HttpGitHubClient>,
    jobs: tauri::State<JobRegistry>,
) -> Result<DeviceAuthorization> {
    github::connect_start(app, client.inner().clone(), jobs.inner().clone())
}

/// Disconnects the GitHub account and removes its registered hooks and token.
#[tauri::command]
pub async fn github_disconnect(app: AppHandle) -> Result<()> {
    github::disconnect(&app).await
}

#[tauri::command]
pub async fn linear_status(app: AppHandle) -> Result<Vec<LinearConnection>> {
    linear::status(&app).await
}

#[tauri::command]
pub fn linear_oauth_configured() -> bool {
    linear::oauth_configured()
}

#[tauri::command]
pub async fn linear_connect_start(app: AppHandle) -> Result<()> {
    linear::connect_start(app).await
}

#[tauri::command]
pub async fn linear_disconnect(app: AppHandle, organization_id: String) -> Result<()> {
    linear::disconnect(&app, &organization_id).await
}

#[tauri::command]
pub async fn linear_sync_connection(
    app: AppHandle,
    organization_id: String,
) -> Result<LinearConnection> {
    if organization_id.trim().is_empty() {
        return Err(std::io::Error::other("Linear workspace is required").into());
    }
    linear::sync_connection(&app, &organization_id).await
}

#[tauri::command]
pub async fn linear_teams(app: AppHandle, organization_id: String) -> Result<Vec<Team>> {
    linear::teams(&app, &organization_id).await
}

#[tauri::command]
pub async fn linear_users(app: AppHandle, organization_id: String) -> Result<Vec<Person>> {
    linear::users(&app, &organization_id).await
}

#[tauri::command]
pub async fn linear_issue_labels(
    app: AppHandle,
    organization_id: String,
) -> Result<Vec<LinearLabel>> {
    linear::issue_labels(&app, &organization_id).await
}

#[tauri::command]
pub async fn linear_create_issue_label(
    app: AppHandle,
    organization_id: String,
    name: String,
    color: String,
    team_id: Option<String>,
) -> Result<LinearLabel> {
    let name = name.trim();
    let color = color.trim();
    if organization_id.trim().is_empty()
        || name.is_empty()
        || name.len() > 255
        || color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(std::io::Error::other("A valid label is required").into());
    }
    let team_id = team_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    linear::create_issue_label(&app, organization_id.trim(), name, color, team_id).await
}

#[tauri::command]
pub async fn linear_update_issue_label(
    app: AppHandle,
    organization_id: String,
    label_id: String,
    name: String,
    color: String,
) -> Result<LinearLabel> {
    let name = name.trim();
    let color = color.trim();
    if organization_id.trim().is_empty()
        || label_id.trim().is_empty()
        || name.is_empty()
        || name.len() > 255
        || color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(std::io::Error::other("A valid label is required").into());
    }
    linear::update_issue_label(&app, organization_id.trim(), label_id.trim(), name, color).await
}

#[tauri::command]
pub async fn linear_delete_issue_label(
    app: AppHandle,
    organization_id: String,
    label_id: String,
) -> Result<()> {
    if organization_id.trim().is_empty() || label_id.trim().is_empty() {
        return Err(std::io::Error::other("Issue label is required").into());
    }
    linear::delete_issue_label(&app, organization_id.trim(), label_id.trim()).await
}

#[tauri::command]
pub async fn linear_projects(
    app: AppHandle,
    organization_id: String,
    include_archived: bool,
) -> Result<Vec<LinearProject>> {
    linear::projects(&app, &organization_id, include_archived).await
}

#[tauri::command]
pub async fn linear_archive_project(
    app: AppHandle,
    organization_id: String,
    project_id: String,
) -> Result<()> {
    if organization_id.trim().is_empty() || project_id.trim().is_empty() {
        return Err(std::io::Error::other("Project is required").into());
    }
    linear::archive_project(&app, &organization_id, &project_id).await
}

#[tauri::command]
pub async fn linear_unarchive_project(
    app: AppHandle,
    organization_id: String,
    project_id: String,
) -> Result<()> {
    if organization_id.trim().is_empty() || project_id.trim().is_empty() {
        return Err(std::io::Error::other("Project is required").into());
    }
    linear::unarchive_project(&app, &organization_id, &project_id).await
}

#[tauri::command]
pub async fn linear_create_project(
    app: AppHandle,
    organization_id: String,
    team_id: String,
    name: String,
    description: Option<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    status_id: Option<String>,
    lead_id: Option<String>,
) -> Result<LinearProject> {
    if name.trim().is_empty()
        || name.chars().count() > 255
        || team_id.trim().is_empty()
        || status_id.as_ref().is_some_and(|id| id.trim().is_empty())
        || lead_id.as_ref().is_some_and(|id| id.trim().is_empty())
    {
        return Err(std::io::Error::other("Project name and team are required").into());
    }
    linear::create_project(
        &app,
        &organization_id,
        &team_id,
        name.trim(),
        description.as_deref(),
        start_date.as_deref(),
        target_date.as_deref(),
        status_id.as_deref(),
        lead_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn linear_update_project(
    app: AppHandle,
    organization_id: String,
    project_id: String,
    name: String,
    description: String,
    start_date: Option<String>,
    target_date: Option<String>,
    status_id: Option<String>,
    lead_id: Option<String>,
    clear_lead: Option<bool>,
) -> Result<LinearProject> {
    if project_id.trim().is_empty()
        || name.chars().count() > 255
        || status_id.as_ref().is_some_and(|id| id.trim().is_empty())
        || lead_id.as_ref().is_some_and(|id| id.trim().is_empty())
        || (clear_lead.unwrap_or(false) && lead_id.is_some())
    {
        return Err(std::io::Error::other("Project name is required").into());
    }
    linear::update_project(
        &app,
        &organization_id,
        &project_id,
        name.trim(),
        &description,
        start_date.as_deref(),
        target_date.as_deref(),
        status_id.as_deref(),
        lead_id.as_deref(),
        clear_lead.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn linear_project_statuses(
    app: AppHandle,
    organization_id: String,
) -> Result<Vec<LinearProjectStatus>> {
    if organization_id.trim().is_empty() {
        return Err(std::io::Error::other("Linear workspace is required").into());
    }
    linear::project_statuses(&app, &organization_id).await
}

#[tauri::command]
pub async fn linear_project_milestones(
    app: AppHandle,
    organization_id: String,
    project_id: String,
) -> Result<Vec<LinearMilestone>> {
    if project_id.trim().is_empty() {
        return Err(std::io::Error::other("Project is required").into());
    }
    linear::project_milestones(&app, &organization_id, &project_id).await
}

#[tauri::command]
pub async fn linear_project_updates(
    app: AppHandle,
    organization_id: String,
    project_id: String,
    include_archived: Option<bool>,
) -> Result<Vec<LinearProjectUpdate>> {
    if project_id.trim().is_empty() {
        return Err(std::io::Error::other("Project is required").into());
    }
    linear::project_updates(
        &app,
        &organization_id,
        &project_id,
        include_archived.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn linear_archive_project_update(
    app: AppHandle,
    organization_id: String,
    update_id: String,
) -> Result<()> {
    if update_id.trim().is_empty() {
        return Err(std::io::Error::other("Project update is required").into());
    }
    linear::archive_project_update(&app, &organization_id, &update_id).await
}

#[tauri::command]
pub async fn linear_unarchive_project_update(
    app: AppHandle,
    organization_id: String,
    update_id: String,
) -> Result<()> {
    if update_id.trim().is_empty() {
        return Err(std::io::Error::other("Project update is required").into());
    }
    linear::unarchive_project_update(&app, &organization_id, &update_id).await
}

#[tauri::command]
pub async fn linear_create_project_update(
    app: AppHandle,
    organization_id: String,
    project_id: String,
    body: String,
    health: String,
) -> Result<LinearProjectUpdate> {
    let body = body.trim();
    if project_id.trim().is_empty() || body.is_empty() || body.chars().count() > 10_000 {
        return Err(
            std::io::Error::other("A project update up to 10,000 characters is required").into(),
        );
    }
    if !matches!(health.as_str(), "onTrack" | "atRisk" | "offTrack") {
        return Err(
            std::io::Error::other("Project health must be onTrack, atRisk, or offTrack").into(),
        );
    }
    linear::create_project_update(&app, &organization_id, &project_id, body, &health).await
}

#[tauri::command]
pub async fn linear_update_project_update(
    app: AppHandle,
    organization_id: String,
    update_id: String,
    body: String,
    health: String,
) -> Result<LinearProjectUpdate> {
    let body = body.trim();
    if update_id.trim().is_empty() || body.is_empty() || body.chars().count() > 10_000 {
        return Err(
            std::io::Error::other("A project update up to 10,000 characters is required").into(),
        );
    }
    if !matches!(health.as_str(), "onTrack" | "atRisk" | "offTrack") {
        return Err(
            std::io::Error::other("Project health must be onTrack, atRisk, or offTrack").into(),
        );
    }
    linear::update_project_update(&app, &organization_id, &update_id, body, &health).await
}

#[tauri::command]
pub async fn linear_create_milestone(
    app: AppHandle,
    organization_id: String,
    project_id: String,
    name: String,
    description: Option<String>,
    target_date: Option<String>,
) -> Result<LinearMilestone> {
    if project_id.trim().is_empty() || name.trim().is_empty() || name.chars().count() > 255 {
        return Err(std::io::Error::other("Milestone name is required").into());
    }
    linear::create_milestone(
        &app,
        &organization_id,
        &project_id,
        name.trim(),
        description.as_deref(),
        target_date.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn linear_update_milestone(
    app: AppHandle,
    organization_id: String,
    milestone_id: String,
    name: String,
    description: String,
    target_date: Option<String>,
) -> Result<LinearMilestone> {
    if milestone_id.trim().is_empty() || name.trim().is_empty() || name.chars().count() > 255 {
        return Err(std::io::Error::other("Milestone name is required").into());
    }
    linear::update_milestone(
        &app,
        &organization_id,
        &milestone_id,
        name.trim(),
        &description,
        target_date.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn linear_delete_milestone(
    app: AppHandle,
    organization_id: String,
    milestone_id: String,
) -> Result<()> {
    if organization_id.trim().is_empty() || milestone_id.trim().is_empty() {
        return Err(std::io::Error::other("Milestone is required").into());
    }
    linear::delete_milestone(&app, &organization_id, &milestone_id).await
}

#[tauri::command]
pub async fn linear_initiatives(
    app: AppHandle,
    organization_id: String,
    include_archived: Option<bool>,
    include_archived_updates: Option<bool>,
) -> Result<Vec<Initiative>> {
    linear::initiatives(
        &app,
        &organization_id,
        include_archived.unwrap_or(false),
        include_archived_updates.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn linear_create_initiative_update(
    app: AppHandle,
    organization_id: String,
    initiative_id: String,
    body: String,
    health: String,
) -> Result<InitiativeUpdate> {
    if organization_id.trim().is_empty()
        || initiative_id.trim().is_empty()
        || body.trim().is_empty()
        || body.chars().count() > 10_000
        || !matches!(health.as_str(), "onTrack" | "atRisk" | "offTrack")
    {
        return Err(std::io::Error::other("A valid initiative update is required").into());
    }
    linear::create_initiative_update(&app, &organization_id, &initiative_id, body.trim(), &health)
        .await
}

#[tauri::command]
pub async fn linear_archive_initiative(
    app: AppHandle,
    organization_id: String,
    initiative_id: String,
) -> Result<()> {
    if initiative_id.trim().is_empty() {
        return Err(std::io::Error::other("Initiative is required").into());
    }
    linear::archive_initiative(&app, &organization_id, &initiative_id).await
}

#[tauri::command]
pub async fn linear_unarchive_initiative(
    app: AppHandle,
    organization_id: String,
    initiative_id: String,
) -> Result<()> {
    if initiative_id.trim().is_empty() {
        return Err(std::io::Error::other("Initiative is required").into());
    }
    linear::unarchive_initiative(&app, &organization_id, &initiative_id).await
}

#[tauri::command]
pub async fn linear_create_initiative(
    app: AppHandle,
    organization_id: String,
    name: String,
    description: Option<String>,
    target_date: Option<String>,
) -> Result<Initiative> {
    if organization_id.trim().is_empty() || name.trim().is_empty() || name.chars().count() > 255 {
        return Err(std::io::Error::other("Initiative name is required").into());
    }
    linear::create_initiative(
        &app,
        &organization_id,
        name.trim(),
        description.as_deref(),
        target_date.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn linear_update_initiative_update(
    app: AppHandle,
    organization_id: String,
    update_id: String,
    body: String,
    health: String,
) -> Result<InitiativeUpdate> {
    if organization_id.trim().is_empty()
        || update_id.trim().is_empty()
        || body.trim().is_empty()
        || body.chars().count() > 10_000
        || !matches!(health.as_str(), "onTrack" | "atRisk" | "offTrack")
    {
        return Err(std::io::Error::other("A valid initiative update is required").into());
    }
    linear::update_initiative_update(&app, &organization_id, &update_id, body.trim(), &health).await
}

#[tauri::command]
pub async fn linear_archive_initiative_update(
    app: AppHandle,
    organization_id: String,
    update_id: String,
) -> Result<()> {
    if organization_id.trim().is_empty() || update_id.trim().is_empty() {
        return Err(std::io::Error::other("Initiative update is required").into());
    }
    linear::archive_initiative_update(&app, &organization_id, &update_id).await
}

#[tauri::command]
pub async fn linear_unarchive_initiative_update(
    app: AppHandle,
    organization_id: String,
    update_id: String,
) -> Result<()> {
    if organization_id.trim().is_empty() || update_id.trim().is_empty() {
        return Err(std::io::Error::other("Initiative update is required").into());
    }
    linear::unarchive_initiative_update(&app, &organization_id, &update_id).await
}

#[tauri::command]
pub async fn linear_update_initiative(
    app: AppHandle,
    organization_id: String,
    initiative_id: String,
    name: String,
    description: String,
    target_date: Option<String>,
) -> Result<Initiative> {
    if organization_id.trim().is_empty()
        || initiative_id.trim().is_empty()
        || name.trim().is_empty()
        || name.chars().count() > 255
    {
        return Err(std::io::Error::other("Initiative name is required").into());
    }
    linear::update_initiative(
        &app,
        &organization_id,
        &initiative_id,
        name.trim(),
        &description,
        target_date.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn linear_add_project_to_initiative(
    app: AppHandle,
    organization_id: String,
    initiative_id: String,
    project_id: String,
) -> Result<InitiativeProject> {
    if organization_id.trim().is_empty()
        || initiative_id.trim().is_empty()
        || project_id.trim().is_empty()
    {
        return Err(std::io::Error::other("Initiative and project are required").into());
    }
    linear::add_project_to_initiative(&app, &organization_id, &initiative_id, &project_id).await
}

#[tauri::command]
pub async fn linear_remove_project_from_initiative(
    app: AppHandle,
    organization_id: String,
    link_id: String,
) -> Result<()> {
    if organization_id.trim().is_empty() || link_id.trim().is_empty() {
        return Err(std::io::Error::other("Initiative project link is required").into());
    }
    linear::remove_project_from_initiative(&app, &organization_id, &link_id).await
}

#[tauri::command]
pub async fn linear_cycles(
    app: AppHandle,
    organization_id: String,
    team_id: String,
) -> Result<Vec<LinearCycle>> {
    linear::cycles(&app, &organization_id, &team_id).await
}

#[tauri::command]
pub async fn linear_create_cycle(
    app: AppHandle,
    organization_id: String,
    team_id: String,
    name: Option<String>,
    starts_at: String,
    ends_at: String,
) -> Result<LinearCycle> {
    if organization_id.trim().is_empty()
        || team_id.trim().is_empty()
        || starts_at.trim().is_empty()
        || ends_at.trim().is_empty()
        || starts_at >= ends_at
        || name
            .as_ref()
            .is_some_and(|value| value.chars().count() > 255)
    {
        return Err(std::io::Error::other("A valid cycle schedule is required").into());
    }
    linear::create_cycle(
        &app,
        &organization_id,
        &team_id,
        name.as_deref(),
        &starts_at,
        &ends_at,
    )
    .await
}

#[tauri::command]
pub async fn linear_update_cycle(
    app: AppHandle,
    organization_id: String,
    cycle_id: String,
    name: String,
    description: String,
    starts_at: Option<String>,
    ends_at: Option<String>,
) -> Result<LinearCycle> {
    if organization_id.trim().is_empty()
        || cycle_id.trim().is_empty()
        || name.chars().count() > 255
        || description.chars().count() > 10_000
        || starts_at
            .as_ref()
            .is_some_and(|date| date.trim().is_empty())
        || ends_at.as_ref().is_some_and(|date| date.trim().is_empty())
    {
        return Err(std::io::Error::other("Cycle details are required").into());
    }
    linear::update_cycle(
        &app,
        &organization_id,
        &cycle_id,
        name.trim(),
        &description,
        starts_at.as_deref(),
        ends_at.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn linear_workflow_states(
    app: AppHandle,
    organization_id: String,
    team_id: String,
) -> Result<Vec<WorkflowState>> {
    linear::workflow_states(&app, &organization_id, &team_id).await
}

#[tauri::command]
pub async fn linear_create_issue(
    app: AppHandle,
    organization_id: String,
    team_id: String,
    title: String,
    description: Option<String>,
    estimate: Option<u32>,
    project_id: Option<String>,
    project_milestone_id: Option<String>,
    parent_id: Option<String>,
) -> Result<Issue> {
    if title.trim().is_empty()
        || title.chars().count() > 255
        || estimate.is_some_and(|value| value > 64)
        || project_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        || project_milestone_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        || parent_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
    {
        return Err(std::io::Error::other("Issue title must be 1–255 characters").into());
    }
    linear::create_issue(
        &app,
        &organization_id,
        &team_id,
        title.trim(),
        description.as_deref(),
        estimate,
        project_id.as_deref(),
        project_milestone_id.as_deref(),
        parent_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn linear_issue_detail(
    app: AppHandle,
    organization_id: String,
    issue_id: String,
) -> Result<IssueDetail> {
    if issue_id.trim().is_empty() {
        return Err(std::io::Error::other("Issue is required").into());
    }
    linear::issue_detail(&app, &organization_id, &issue_id).await
}

#[tauri::command]
pub async fn linear_create_issue_relation(
    app: AppHandle,
    organization_id: String,
    issue_id: String,
    related_issue_id: String,
    kind: String,
) -> Result<IssueRelation> {
    if organization_id.trim().is_empty()
        || issue_id.trim().is_empty()
        || related_issue_id.trim().is_empty()
        || issue_id
            .trim()
            .eq_ignore_ascii_case(related_issue_id.trim())
        || !matches!(
            kind.as_str(),
            "blocks" | "duplicate" | "related" | "similar"
        )
    {
        return Err(std::io::Error::other("A valid issue relation is required").into());
    }
    linear::create_issue_relation(
        &app,
        &organization_id,
        issue_id.trim(),
        related_issue_id.trim(),
        &kind,
    )
    .await
}

#[tauri::command]
pub async fn linear_delete_issue_relation(
    app: AppHandle,
    organization_id: String,
    relation_id: String,
) -> Result<()> {
    if organization_id.trim().is_empty() || relation_id.trim().is_empty() {
        return Err(std::io::Error::other("Issue relation is required").into());
    }
    linear::delete_issue_relation(&app, &organization_id, relation_id.trim()).await
}

#[tauri::command]
pub async fn linear_create_comment(
    app: AppHandle,
    organization_id: String,
    issue_id: String,
    body: String,
) -> Result<LinearComment> {
    if issue_id.trim().is_empty() || body.trim().is_empty() || body.chars().count() > 10_000 {
        return Err(std::io::Error::other("Comment must be 1–10,000 characters").into());
    }
    linear::create_comment(&app, &organization_id, &issue_id, body.trim()).await
}

#[tauri::command]
pub async fn linear_update_comment(
    app: AppHandle,
    organization_id: String,
    comment_id: String,
    body: String,
) -> Result<LinearComment> {
    if organization_id.trim().is_empty()
        || comment_id.trim().is_empty()
        || body.trim().is_empty()
        || body.chars().count() > 10_000
    {
        return Err(std::io::Error::other("Comment must be 1–10,000 characters").into());
    }
    linear::update_comment(&app, &organization_id, &comment_id, body.trim()).await
}

#[tauri::command]
pub async fn linear_delete_comment(
    app: AppHandle,
    organization_id: String,
    comment_id: String,
) -> Result<()> {
    if organization_id.trim().is_empty() || comment_id.trim().is_empty() {
        return Err(std::io::Error::other("Comment is required").into());
    }
    linear::delete_comment(&app, &organization_id, &comment_id).await
}

#[tauri::command]
pub fn linear_codex_context(
    app: AppHandle,
    organization_id: String,
    issue_id: String,
) -> Result<LinearCodexContext> {
    if organization_id.trim().is_empty() {
        return Err(std::io::Error::other("Linear workspace is required").into());
    }
    linear::codex_context(&app, &organization_id, &issue_id)
}

#[tauri::command]
pub async fn linear_set_codex_project_allowed(
    app: AppHandle,
    organization_id: String,
    project_id: String,
    allowed: bool,
    workspace_repo: Option<String>,
) -> Result<()> {
    if organization_id.trim().is_empty()
        || project_id.trim().is_empty()
        || workspace_repo
            .as_ref()
            .is_some_and(|repo| repo.trim().is_empty())
        || (allowed && workspace_repo.is_none())
    {
        return Err(std::io::Error::other("Linear workspace and project are required").into());
    }
    linear::set_codex_project_allowed(
        &app,
        &organization_id,
        &project_id,
        allowed,
        workspace_repo.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn linear_save_codex_link(
    app: AppHandle,
    organization_id: String,
    issue_id: String,
    workspace_repo: String,
    workspace_name: String,
    thread_id: String,
) -> Result<()> {
    if organization_id.trim().is_empty()
        || issue_id.trim().is_empty()
        || workspace_repo.trim().is_empty()
        || workspace_name.trim().is_empty()
        || thread_id.trim().is_empty()
    {
        return Err(std::io::Error::other("Linear and Codex link details are required").into());
    }
    linear::save_codex_link(
        &app,
        &organization_id,
        &issue_id,
        &workspace_repo,
        &workspace_name,
        &thread_id,
    )
    .await
}

#[tauri::command]
pub async fn linear_update_issue(
    app: AppHandle,
    organization_id: String,
    issue_id: String,
    state_id: Option<String>,
    assignee_id: Option<String>,
    clear_assignee: Option<bool>,
    cycle_id: Option<String>,
    clear_cycle: Option<bool>,
    priority: Option<u8>,
    label_ids: Option<Vec<String>>,
    title: Option<String>,
    description: Option<String>,
    project_id: Option<String>,
    clear_project: Option<bool>,
    project_milestone_id: Option<String>,
    clear_project_milestone: Option<bool>,
    due_date: Option<String>,
    clear_due_date: Option<bool>,
    estimate: Option<u32>,
    clear_estimate: Option<bool>,
) -> Result<Issue> {
    if organization_id.trim().is_empty()
        || issue_id.trim().is_empty()
        || priority.is_some_and(|value| value > 4)
        || title
            .as_ref()
            .is_some_and(|value| value.trim().is_empty() || value.chars().count() > 255)
        || project_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        || (clear_project.unwrap_or(false) && project_id.is_some())
        || project_milestone_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        || (clear_project_milestone.unwrap_or(false) && project_milestone_id.is_some())
        || (clear_project.unwrap_or(false) && project_milestone_id.is_some())
        || due_date.as_ref().is_some_and(|value| {
            let bytes = value.as_bytes();
            bytes.len() != 10
                || bytes[4] != b'-'
                || bytes[7] != b'-'
                || bytes
                    .iter()
                    .enumerate()
                    .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
        })
        || (clear_due_date.unwrap_or(false) && due_date.is_some())
        || estimate.is_some_and(|value| value > 64)
        || (clear_estimate.unwrap_or(false) && estimate.is_some())
        || assignee_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        || cycle_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        || (clear_assignee.unwrap_or(false) && assignee_id.is_some())
        || (clear_cycle.unwrap_or(false) && cycle_id.is_some())
        || label_ids
            .as_ref()
            .is_some_and(|labels| labels.iter().any(|label| label.trim().is_empty()))
    {
        return Err(std::io::Error::other("Invalid Linear issue update").into());
    }
    linear::update_issue(
        &app,
        &organization_id,
        &issue_id,
        state_id.as_deref(),
        assignee_id.as_deref(),
        clear_assignee.unwrap_or(false),
        cycle_id.as_deref(),
        clear_cycle.unwrap_or(false),
        priority,
        label_ids.as_deref(),
        title.as_deref(),
        description.as_deref(),
        project_id.as_deref(),
        clear_project.unwrap_or(false),
        project_milestone_id.as_deref(),
        clear_project_milestone.unwrap_or(false),
        due_date.as_deref(),
        clear_due_date.unwrap_or(false),
        estimate,
        clear_estimate.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn linear_my_issues(
    app: AppHandle,
    organization_id: String,
    search: Option<String>,
    after: Option<String>,
    include_archived: Option<bool>,
) -> Result<IssuePage> {
    if search.as_deref().is_some_and(|query| query.len() > 255) {
        return Err(std::io::Error::other("Issue search is too long").into());
    }
    linear::my_issues(
        &app,
        &organization_id,
        search
            .as_deref()
            .map(str::trim)
            .filter(|search| !search.is_empty()),
        after.as_deref(),
        include_archived.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn linear_team_issues(
    app: AppHandle,
    organization_id: String,
    team_id: String,
    search: Option<String>,
    after: Option<String>,
    include_archived: Option<bool>,
) -> Result<IssuePage> {
    if team_id.trim().is_empty() {
        return Err(std::io::Error::other("A Linear team is required").into());
    }
    if search.as_deref().is_some_and(|query| query.len() > 255) {
        return Err(std::io::Error::other("Issue search is too long").into());
    }
    linear::team_issues(
        &app,
        &organization_id,
        &team_id,
        search
            .as_deref()
            .map(str::trim)
            .filter(|search| !search.is_empty()),
        after.as_deref(),
        include_archived.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn linear_archive_issue(
    app: AppHandle,
    organization_id: String,
    issue_id: String,
) -> Result<()> {
    if issue_id.trim().is_empty() {
        return Err(std::io::Error::other("Issue is required").into());
    }
    linear::archive_issue(&app, &organization_id, &issue_id).await
}

#[tauri::command]
pub async fn linear_unarchive_issue(
    app: AppHandle,
    organization_id: String,
    issue_id: String,
) -> Result<()> {
    if issue_id.trim().is_empty() {
        return Err(std::io::Error::other("Issue is required").into());
    }
    linear::unarchive_issue(&app, &organization_id, &issue_id).await
}

#[tauri::command]
pub async fn linear_project_issues(
    app: AppHandle,
    organization_id: String,
    project_id: String,
    after: Option<String>,
    include_archived: Option<bool>,
) -> Result<IssuePage> {
    linear::project_issues(
        &app,
        &organization_id,
        &project_id,
        after.as_deref(),
        include_archived.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub fn nexus_auth_status() -> Result<nexus_auth::NexusAuthStatus> {
    nexus_auth::status()
}

#[tauri::command]
pub fn nexus_auth_start(app: AppHandle) -> Result<()> {
    nexus_auth::start(&app)
}

#[tauri::command]
pub async fn nexus_auth_login(
    app: AppHandle,
    email: String,
    password: String,
) -> Result<nexus_auth::LoginResult> {
    nexus_auth::login(&app, email, password).await
}

#[tauri::command]
pub async fn nexus_auth_register(
    email: String,
    password: String,
    display_name: String,
) -> Result<()> {
    nexus_auth::register(email, password, display_name).await
}

#[tauri::command]
pub async fn nexus_auth_verify_email(token: String) -> Result<()> {
    nexus_auth::verify_email(token).await
}

#[tauri::command]
pub async fn nexus_auth_verify_mfa(
    app: AppHandle,
    code: String,
    recovery_code: String,
) -> Result<()> {
    nexus_auth::verify_mfa(&app, code, recovery_code).await
}

#[tauri::command]
pub fn nexus_auth_google_start(app: AppHandle) -> Result<()> {
    nexus_auth::google_start(&app)
}

#[tauri::command]
pub fn nexus_auth_logout(app: AppHandle) -> Result<()> {
    nexus_auth::logout(&app)
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

#[tauri::command]
pub fn notifications_list(app: AppHandle) -> Result<Vec<NotificationRecord>> {
    crate::notifications::list(&app)
}

#[tauri::command]
pub fn notifications_mark_read(app: AppHandle, notification_ids: Vec<String>) -> Result<()> {
    crate::notifications::mark_read(&app, &notification_ids)
}

#[tauri::command]
pub fn notifications_clear(app: AppHandle) -> Result<()> {
    crate::notifications::clear(&app)
}

#[cfg(mobile)]
#[tauri::command]
pub async fn mobile_update_check() -> Result<Option<mobile_updates::MobileUpdate>> {
    mobile_updates::check().await
}

/// Discovers a small, bounded set of local Git clones across mounted disks.
///
/// Walking the disk blocks the calling thread, and a sync `#[tauri::command]`
/// runs directly on the native IPC callback thread (see the `jobs` module
/// docs) — that thread also pumps the webview's UI events, so blocking it
/// freezes the whole window, not just this command. Dispatching to a
/// blocking thread keeps the UI responsive while the scan runs.
#[tauri::command]
pub async fn scan_workspaces() -> Result<Vec<WorkspaceSummary>> {
    tauri::async_runtime::spawn_blocking(crate::workspaces::scan)
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?
}

#[cfg(desktop)]
#[tauri::command]
pub async fn codex_send(
    prompt: String,
    working_directory: String,
    thread_id: Option<String>,
) -> Result<crate::codex::CodexRun> {
    crate::codex::send(prompt, working_directory, thread_id).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn codex_list_threads(
    state: tauri::State<'_, crate::codex::CodexState>,
    cursor: Option<String>,
) -> Result<crate::codex::CodexThreadPage> {
    crate::codex::list_threads(&state, cursor).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn codex_read_thread(
    state: tauri::State<'_, crate::codex::CodexState>,
    thread_id: String,
) -> Result<crate::codex::CodexThreadDetails> {
    crate::codex::read_thread(&state, thread_id).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn codex_older_turns(
    state: tauri::State<'_, crate::codex::CodexState>,
    thread_id: String,
    cursor: String,
) -> Result<crate::codex::CodexTurnPage> {
    crate::codex::older_turns(&state, thread_id, Some(cursor)).await
}

/// Opens a local Git clone in the platform terminal.
#[tauri::command]
pub fn open_terminal(path: String) -> Result<()> {
    crate::workspaces::open_terminal(&path)
}

/// Runs one explicitly selected Git or package script action in a local
/// clone. See `scan_workspaces` above for why this has to leave the IPC
/// callback thread: `git fetch`/`pull` can block for as long as the network
/// does, and every other command — including opening an unrelated popover —
/// would stall behind it otherwise.
#[tauri::command]
pub async fn project_action(path: String, action: WorkspaceAction) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || crate::workspaces::run_action(&path, action))
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?
}

#[cfg(desktop)]
#[tauri::command]
pub fn update_status(updates: tauri::State<UpdateManager>) -> UpdateSnapshot {
    updates.snapshot()
}

#[cfg(desktop)]
#[tauri::command]
pub async fn update_check(app: AppHandle, updates: tauri::State<'_, UpdateManager>) -> Result<()> {
    updates.check_and_download(app).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    updates: tauri::State<'_, UpdateManager>,
) -> Result<()> {
    updates.download(app).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    updates: tauri::State<'_, UpdateManager>,
) -> Result<()> {
    updates.install(app).await
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
