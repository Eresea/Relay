mod api;
mod nexus_sync;
mod oauth;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};

pub use api::{
    Initiative, InitiativeProject, InitiativeUpdate, Issue, IssueDetail, IssuePage, IssueRelation,
    LinearComment, LinearCycle, LinearDocument, LinearExternalLink, LinearLabel, LinearMilestone,
    LinearProject, LinearProjectResources, LinearProjectStatus, LinearProjectUpdate, Person, Team,
    Viewer, WorkflowState,
};
use oauth::TokenBundle;
pub use oauth::{LinearCodexLink, LinearCodexProjectPolicy};

const CONNECTIONS_KEY: &str = "linear.connections";
const CODEX_DEVICE_ID_KEY: &str = "linear.codex.device-id";
const PENDING_REVOKES_KEY: &str = "linear.pending-nexus-revokes";
const PAUSED_ON_DEVICE_KEY: &str = "linear.paused-on-device";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearConnection {
    pub organization_id: String,
    pub organization_name: String,
    pub url_key: String,
    pub viewer_id: String,
    pub viewer_name: String,
    pub viewer_email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nexus_credential_id: Option<String>,
    #[serde(default)]
    pub agent_installed: bool,
    #[serde(default)]
    pub paused_on_device: bool,
}

#[derive(Default)]
pub struct LinearState {
    pending: std::sync::Mutex<Option<oauth::PendingAuth>>,
    refresh: tokio::sync::Mutex<()>,
    device_id: std::sync::Mutex<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearCodexContext {
    pub device_id: String,
    pub links: Vec<LinearCodexLink>,
    pub allowed_projects: Vec<LinearCodexProjectPolicy>,
}

pub fn connections(app: &AppHandle) -> Result<Vec<LinearConnection>> {
    app.store("settings.json")
        .map_err(|error| Error::LinearApi(error.to_string()))?
        .get(CONNECTIONS_KEY)
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| Error::LinearApi(error.to_string()))
        .map(Option::unwrap_or_default)
}

fn pending_revokes(app: &AppHandle) -> Result<Vec<String>> {
    app.store("settings.json")
        .map_err(|error| Error::LinearApi(error.to_string()))?
        .get(PENDING_REVOKES_KEY)
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| Error::LinearApi(error.to_string()))
        .map(Option::unwrap_or_default)
}

fn paused_on_device(app: &AppHandle) -> Result<Vec<String>> {
    app.store("settings.json")
        .map_err(|error| Error::LinearApi(error.to_string()))?
        .get(PAUSED_ON_DEVICE_KEY)
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| Error::LinearApi(error.to_string()))
        .map(Option::unwrap_or_default)
}

fn set_paused_on_device(app: &AppHandle, organization_id: &str, paused: bool) -> Result<()> {
    let store = app
        .store("settings.json")
        .map_err(|error| Error::LinearApi(error.to_string()))?;
    let mut organizations = paused_on_device(app)?;
    update_paused_on_device(&mut organizations, organization_id, paused);
    store.set(
        PAUSED_ON_DEVICE_KEY,
        serde_json::to_value(organizations).map_err(|error| Error::LinearApi(error.to_string()))?,
    );
    store
        .save()
        .map_err(|error| Error::LinearApi(error.to_string()))
}

fn update_paused_on_device(organizations: &mut Vec<String>, organization_id: &str, paused: bool) {
    if paused {
        if !organizations.iter().any(|id| id == organization_id) {
            organizations.push(organization_id.to_owned());
        }
    } else {
        organizations.retain(|id| id != organization_id);
    }
}

fn ensure_not_paused(app: &AppHandle, organization_id: &str) -> Result<()> {
    if paused_on_device(app)?
        .iter()
        .any(|id| id == organization_id)
    {
        return Err(Error::LinearApi("Linear is paused on this device".into()));
    }
    Ok(())
}

fn update_pending_revoke(organizations: &mut Vec<String>, organization_id: &str, revoked: bool) {
    if revoked {
        organizations.retain(|id| id != organization_id);
    } else if !organizations.iter().any(|id| id == organization_id) {
        organizations.push(organization_id.to_owned());
    }
}

fn save_pending_revokes(app: &AppHandle, organizations: &[String]) -> Result<()> {
    let store = app
        .store("settings.json")
        .map_err(|error| Error::LinearApi(error.to_string()))?;
    store.set(
        PENDING_REVOKES_KEY,
        serde_json::to_value(organizations).map_err(|error| Error::LinearApi(error.to_string()))?,
    );
    store
        .save()
        .map_err(|error| Error::LinearApi(error.to_string()))
}

pub(super) fn cancel_pending_revoke(app: &AppHandle, organization_id: &str) -> Result<()> {
    let mut pending = pending_revokes(app)?;
    let count = pending.len();
    update_pending_revoke(&mut pending, organization_id, true);
    if pending.len() != count {
        save_pending_revokes(app, &pending)?;
    }
    Ok(())
}

fn save_connection(app: &AppHandle, connection: LinearConnection) -> Result<()> {
    let store = app
        .store("settings.json")
        .map_err(|error| Error::LinearApi(error.to_string()))?;
    let mut connections = connections(app)?;
    connections.retain(|existing| existing.organization_id != connection.organization_id);
    connections.push(connection);
    store.set(
        CONNECTIONS_KEY,
        serde_json::to_value(connections).map_err(|error| Error::LinearApi(error.to_string()))?,
    );
    store
        .save()
        .map_err(|error| Error::LinearApi(error.to_string()))
}

pub async fn connect_start(app: AppHandle) -> Result<()> {
    oauth::start(app).await
}

pub fn cancel_connect(app: &AppHandle) {
    oauth::cancel(app);
}

pub async fn agent_install_start(app: AppHandle, organization_id: String) -> Result<()> {
    oauth::start_agent(app, organization_id).await
}

pub fn oauth_configured() -> bool {
    oauth::configured()
}

pub async fn handle_callback(app: AppHandle, url: url::Url) {
    oauth::handle_callback(app, url).await;
}

pub async fn status(app: &AppHandle) -> Result<Vec<LinearConnection>> {
    if crate::nexus_auth::status().is_ok_and(|status| status.connected) {
        let mut pending = pending_revokes(app)?;
        let original_pending = pending.clone();
        for organization_id in pending.clone() {
            if nexus_sync::revoke(app, &organization_id).await.is_ok() {
                update_pending_revoke(&mut pending, &organization_id, true);
            }
        }
        if pending != original_pending {
            save_pending_revokes(app, &pending)?;
        }
        if let Ok(remote) = nexus_sync::discover(app).await {
            let pending_set = pending.iter().collect::<std::collections::HashSet<_>>();
            let remote_ids = remote
                .iter()
                .filter(|(_, connection, _)| !pending_set.contains(&connection.organization_id))
                .map(|(id, _, _)| id.clone())
                .collect::<std::collections::HashSet<_>>();
            let local = connections(app)?;
            for connection in &local {
                if connection
                    .nexus_credential_id
                    .as_deref()
                    .is_some_and(|id| !remote_ids.contains(id))
                {
                    if let Ok(entry) = token_entry(&connection.organization_id) {
                        let _ = entry.delete_credential();
                    }
                }
            }
            let mut remaining = local
                .into_iter()
                .filter(|connection| {
                    connection
                        .nexus_credential_id
                        .as_deref()
                        .is_none_or(|id| remote_ids.contains(id))
                })
                .collect::<Vec<_>>();
            for (credential_id, mut connection, bundle) in remote {
                if pending_set.contains(&connection.organization_id) {
                    continue;
                }
                connection.nexus_credential_id = Some(credential_id);
                token_entry(&connection.organization_id)?
                    .set_password(
                        &serde_json::to_string(&bundle)
                            .map_err(|error| Error::LinearApi(error.to_string()))?,
                    )
                    .map_err(|error| Error::SecretStoreUnavailable(error.to_string()))?;
                remaining.retain(|existing| existing.organization_id != connection.organization_id);
                remaining.push(connection);
            }
            save_connections(app, remaining)?;
        }
    }
    let mut connections = connections(app)?;
    let paused = paused_on_device(app)?;
    for connection in &mut connections {
        connection.agent_installed = stored_bundle(&connection.organization_id)
            .ok()
            .is_some_and(|bundle| bundle.agent.is_some());
        connection.paused_on_device = paused.iter().any(|id| id == &connection.organization_id);
    }
    Ok(connections)
}

pub fn pause_on_device(app: &AppHandle, organization_id: &str, paused: bool) -> Result<()> {
    if !connections(app)?
        .iter()
        .any(|connection| connection.organization_id == organization_id)
    {
        return Err(Error::LinearApi("Linear workspace is not connected".into()));
    }
    set_paused_on_device(app, organization_id, paused)
}

pub async fn disconnect(app: &AppHandle, organization_id: &str) -> Result<Option<String>> {
    let remote_revoke = nexus_sync::revoke(app, organization_id).await;
    let entry = token_entry(organization_id)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(Error::SecretStoreUnavailable(error.to_string())),
    }
    let store = app
        .store("settings.json")
        .map_err(|error| Error::LinearApi(error.to_string()))?;
    let mut connections = connections(app)?;
    connections.retain(|connection| connection.organization_id != organization_id);
    let mut pending = pending_revokes(app)?;
    update_pending_revoke(&mut pending, organization_id, remote_revoke.is_ok());
    set_paused_on_device(app, organization_id, false)?;
    store.set(
        CONNECTIONS_KEY,
        serde_json::to_value(connections).map_err(|error| Error::LinearApi(error.to_string()))?,
    );
    store.set(
        PENDING_REVOKES_KEY,
        serde_json::to_value(&pending).map_err(|error| Error::LinearApi(error.to_string()))?,
    );
    store
        .save()
        .map_err(|error| Error::LinearApi(error.to_string()))?;
    Ok(remote_revoke.err().map(|_| {
        "Disconnected on this device; Nexus will revoke access on other devices when it reconnects."
            .to_owned()
    }))
}

pub async fn sync_connection(app: &AppHandle, organization_id: &str) -> Result<LinearConnection> {
    let mut connection = connections(app)?
        .into_iter()
        .find(|connection| connection.organization_id == organization_id)
        .ok_or_else(|| Error::LinearApi("Linear workspace is not connected".into()))?;
    access_token(app, organization_id).await?;
    let encoded = token_entry(organization_id)?
        .get_password()
        .map_err(|error| Error::SecretStoreUnavailable(error.to_string()))?;
    let bundle: TokenBundle = serde_json::from_str(&encoded)
        .map_err(|_| Error::LinearApi("stored Linear credentials are invalid".into()))?;
    connection.nexus_credential_id = Some(nexus_sync::persist(app, &connection, &bundle).await?);
    cancel_pending_revoke(app, organization_id)?;
    save_connection(app, connection.clone())?;
    Ok(connection)
}

pub async fn teams(app: &AppHandle, organization_id: &str) -> Result<Vec<Team>> {
    api::teams(&access_token(app, organization_id).await?).await
}

pub async fn users(app: &AppHandle, organization_id: &str) -> Result<Vec<Person>> {
    api::users(&access_token(app, organization_id).await?).await
}

pub async fn issue_labels(app: &AppHandle, organization_id: &str) -> Result<Vec<LinearLabel>> {
    api::issue_labels(&access_token(app, organization_id).await?).await
}

pub async fn create_issue_label(
    app: &AppHandle,
    organization_id: &str,
    name: &str,
    color: &str,
    team_id: Option<&str>,
) -> Result<LinearLabel> {
    api::create_issue_label(
        &access_token(app, organization_id).await?,
        name,
        color,
        team_id,
    )
    .await
}

pub async fn update_issue_label(
    app: &AppHandle,
    organization_id: &str,
    label_id: &str,
    name: &str,
    color: &str,
) -> Result<LinearLabel> {
    api::update_issue_label(
        &access_token(app, organization_id).await?,
        label_id,
        name,
        color,
    )
    .await
}

pub async fn delete_issue_label(
    app: &AppHandle,
    organization_id: &str,
    label_id: &str,
) -> Result<()> {
    api::delete_issue_label(&access_token(app, organization_id).await?, label_id).await
}

pub async fn projects(
    app: &AppHandle,
    organization_id: &str,
    include_archived: bool,
) -> Result<Vec<LinearProject>> {
    api::projects(&access_token(app, organization_id).await?, include_archived).await
}

pub async fn archive_project(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
) -> Result<()> {
    api::archive_project(&access_token(app, organization_id).await?, project_id).await
}

pub async fn unarchive_project(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
) -> Result<()> {
    api::unarchive_project(&access_token(app, organization_id).await?, project_id).await
}

pub async fn create_project(
    app: &AppHandle,
    organization_id: &str,
    team_ids: &[String],
    name: &str,
    description: Option<&str>,
    start_date: Option<&str>,
    target_date: Option<&str>,
    status_id: Option<&str>,
    lead_id: Option<&str>,
) -> Result<LinearProject> {
    api::create_project(
        &access_token(app, organization_id).await?,
        team_ids,
        name,
        description,
        start_date,
        target_date,
        status_id,
        lead_id,
    )
    .await
}

pub async fn update_project(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    name: &str,
    description: &str,
    start_date: Option<&str>,
    target_date: Option<&str>,
    status_id: Option<&str>,
    lead_id: Option<&str>,
    clear_lead: bool,
    team_ids: &[String],
) -> Result<LinearProject> {
    api::update_project(
        &access_token(app, organization_id).await?,
        project_id,
        name,
        description,
        start_date,
        target_date,
        status_id,
        lead_id,
        clear_lead,
        team_ids,
    )
    .await
}

pub async fn project_resources(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
) -> Result<LinearProjectResources> {
    api::project_resources(&access_token(app, organization_id).await?, project_id).await
}

pub async fn create_project_document(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    title: &str,
    content: &str,
) -> Result<LinearDocument> {
    api::create_project_document(
        &access_token(app, organization_id).await?,
        project_id,
        title,
        content,
    )
    .await
}

pub async fn project_document(
    app: &AppHandle,
    organization_id: &str,
    document_id: &str,
) -> Result<LinearDocument> {
    api::project_document(&access_token(app, organization_id).await?, document_id).await
}

pub async fn update_project_document(
    app: &AppHandle,
    organization_id: &str,
    document_id: &str,
    expected_updated_at: &str,
    title: &str,
    content: &str,
) -> Result<LinearDocument> {
    api::update_project_document(
        &access_token(app, organization_id).await?,
        document_id,
        expected_updated_at,
        title,
        content,
    )
    .await
}

pub async fn create_project_external_link(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    label: &str,
    url: &str,
) -> Result<LinearExternalLink> {
    api::create_project_external_link(
        &access_token(app, organization_id).await?,
        project_id,
        label,
        url,
    )
    .await
}

pub async fn delete_project_external_link(
    app: &AppHandle,
    organization_id: &str,
    link_id: &str,
) -> Result<()> {
    api::delete_project_external_link(&access_token(app, organization_id).await?, link_id).await
}

pub async fn project_statuses(
    app: &AppHandle,
    organization_id: &str,
) -> Result<Vec<LinearProjectStatus>> {
    api::project_statuses(&access_token(app, organization_id).await?).await
}

pub async fn project_milestones(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
) -> Result<Vec<LinearMilestone>> {
    api::project_milestones(&access_token(app, organization_id).await?, project_id).await
}

pub async fn project_updates(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    include_archived: bool,
) -> Result<Vec<LinearProjectUpdate>> {
    api::project_updates(
        &access_token(app, organization_id).await?,
        project_id,
        include_archived,
    )
    .await
}

pub async fn archive_project_update(
    app: &AppHandle,
    organization_id: &str,
    update_id: &str,
) -> Result<()> {
    api::archive_project_update(&access_token(app, organization_id).await?, update_id).await
}

pub async fn unarchive_project_update(
    app: &AppHandle,
    organization_id: &str,
    update_id: &str,
) -> Result<()> {
    api::unarchive_project_update(&access_token(app, organization_id).await?, update_id).await
}

pub async fn create_project_update(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    body: &str,
    health: &str,
) -> Result<LinearProjectUpdate> {
    api::create_project_update(
        &access_token(app, organization_id).await?,
        project_id,
        body,
        health,
    )
    .await
}

pub async fn update_project_update(
    app: &AppHandle,
    organization_id: &str,
    update_id: &str,
    body: &str,
    health: &str,
) -> Result<LinearProjectUpdate> {
    api::update_project_update(
        &access_token(app, organization_id).await?,
        update_id,
        body,
        health,
    )
    .await
}

pub async fn create_milestone(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    name: &str,
    description: Option<&str>,
    target_date: Option<&str>,
) -> Result<LinearMilestone> {
    api::create_milestone(
        &access_token(app, organization_id).await?,
        project_id,
        name,
        description,
        target_date,
    )
    .await
}

pub async fn update_milestone(
    app: &AppHandle,
    organization_id: &str,
    milestone_id: &str,
    name: &str,
    description: &str,
    target_date: Option<&str>,
) -> Result<LinearMilestone> {
    api::update_milestone(
        &access_token(app, organization_id).await?,
        milestone_id,
        name,
        description,
        target_date,
    )
    .await
}

pub async fn delete_milestone(
    app: &AppHandle,
    organization_id: &str,
    milestone_id: &str,
) -> Result<()> {
    api::delete_milestone(&access_token(app, organization_id).await?, milestone_id).await
}

pub async fn initiatives(
    app: &AppHandle,
    organization_id: &str,
    include_archived: bool,
    include_archived_updates: bool,
) -> Result<Vec<Initiative>> {
    api::initiatives(
        &access_token(app, organization_id).await?,
        include_archived,
        include_archived_updates,
    )
    .await
}

pub async fn create_initiative_update(
    app: &AppHandle,
    organization_id: &str,
    initiative_id: &str,
    body: &str,
    health: &str,
) -> Result<InitiativeUpdate> {
    api::create_initiative_update(
        &access_token(app, organization_id).await?,
        initiative_id,
        body,
        health,
    )
    .await
}

pub async fn update_initiative_update(
    app: &AppHandle,
    organization_id: &str,
    update_id: &str,
    body: &str,
    health: &str,
) -> Result<InitiativeUpdate> {
    api::update_initiative_update(
        &access_token(app, organization_id).await?,
        update_id,
        body,
        health,
    )
    .await
}

pub async fn archive_initiative_update(
    app: &AppHandle,
    organization_id: &str,
    update_id: &str,
) -> Result<()> {
    api::archive_initiative_update(&access_token(app, organization_id).await?, update_id).await
}

pub async fn unarchive_initiative_update(
    app: &AppHandle,
    organization_id: &str,
    update_id: &str,
) -> Result<()> {
    api::unarchive_initiative_update(&access_token(app, organization_id).await?, update_id).await
}

pub async fn archive_initiative(
    app: &AppHandle,
    organization_id: &str,
    initiative_id: &str,
) -> Result<()> {
    api::archive_initiative(&access_token(app, organization_id).await?, initiative_id).await
}

pub async fn unarchive_initiative(
    app: &AppHandle,
    organization_id: &str,
    initiative_id: &str,
) -> Result<()> {
    api::unarchive_initiative(&access_token(app, organization_id).await?, initiative_id).await
}

pub async fn create_initiative(
    app: &AppHandle,
    organization_id: &str,
    name: &str,
    description: Option<&str>,
    target_date: Option<&str>,
) -> Result<Initiative> {
    api::create_initiative(
        &access_token(app, organization_id).await?,
        name,
        description,
        target_date,
    )
    .await
}

pub async fn update_initiative(
    app: &AppHandle,
    organization_id: &str,
    initiative_id: &str,
    name: &str,
    description: &str,
    target_date: Option<&str>,
) -> Result<Initiative> {
    api::update_initiative(
        &access_token(app, organization_id).await?,
        initiative_id,
        name,
        description,
        target_date,
    )
    .await
}

pub async fn add_project_to_initiative(
    app: &AppHandle,
    organization_id: &str,
    initiative_id: &str,
    project_id: &str,
) -> Result<api::InitiativeProject> {
    api::add_project_to_initiative(
        &access_token(app, organization_id).await?,
        initiative_id,
        project_id,
    )
    .await
}

pub async fn remove_project_from_initiative(
    app: &AppHandle,
    organization_id: &str,
    link_id: &str,
) -> Result<()> {
    api::remove_project_from_initiative(&access_token(app, organization_id).await?, link_id).await
}

pub async fn cycles(
    app: &AppHandle,
    organization_id: &str,
    team_id: &str,
) -> Result<Vec<LinearCycle>> {
    api::cycles(&access_token(app, organization_id).await?, team_id).await
}

pub async fn create_cycle(
    app: &AppHandle,
    organization_id: &str,
    team_id: &str,
    name: Option<&str>,
    starts_at: &str,
    ends_at: &str,
) -> Result<LinearCycle> {
    api::create_cycle(
        &access_token(app, organization_id).await?,
        team_id,
        name,
        starts_at,
        ends_at,
    )
    .await
}

pub async fn update_cycle(
    app: &AppHandle,
    organization_id: &str,
    cycle_id: &str,
    name: &str,
    description: &str,
    starts_at: Option<&str>,
    ends_at: Option<&str>,
) -> Result<LinearCycle> {
    api::update_cycle(
        &access_token(app, organization_id).await?,
        cycle_id,
        name,
        description,
        starts_at,
        ends_at,
    )
    .await
}

pub async fn workflow_states(
    app: &AppHandle,
    organization_id: &str,
    team_id: &str,
) -> Result<Vec<WorkflowState>> {
    api::workflow_states(&access_token(app, organization_id).await?, team_id).await
}

pub async fn create_issue(
    app: &AppHandle,
    organization_id: &str,
    team_id: &str,
    title: &str,
    description: Option<&str>,
    estimate: Option<u32>,
    assignee_id: Option<&str>,
    priority: Option<u8>,
    due_date: Option<&str>,
    label_ids: Option<&[String]>,
    project_id: Option<&str>,
    project_milestone_id: Option<&str>,
    parent_id: Option<&str>,
    state_id: Option<&str>,
    cycle_id: Option<&str>,
) -> Result<Issue> {
    let viewer_id = connections(app)?
        .into_iter()
        .find(|connection| connection.organization_id == organization_id)
        .ok_or_else(|| Error::LinearApi("Linear workspace is not connected".into()))?
        .viewer_id;
    api::create_issue(
        &access_token(app, organization_id).await?,
        team_id,
        title,
        description,
        estimate,
        assignee_id.or(Some(&viewer_id)),
        priority,
        due_date,
        label_ids,
        project_id,
        project_milestone_id,
        parent_id,
        state_id,
        cycle_id,
    )
    .await
}

pub async fn issue_detail(
    app: &AppHandle,
    organization_id: &str,
    issue_id: &str,
) -> Result<IssueDetail> {
    api::issue_detail(&access_token(app, organization_id).await?, issue_id).await
}

pub async fn create_issue_relation(
    app: &AppHandle,
    organization_id: &str,
    issue_id: &str,
    related_issue_id: &str,
    kind: &str,
) -> Result<IssueRelation> {
    api::create_issue_relation(
        &access_token(app, organization_id).await?,
        issue_id,
        related_issue_id,
        kind,
    )
    .await
}

pub async fn delete_issue_relation(
    app: &AppHandle,
    organization_id: &str,
    relation_id: &str,
) -> Result<()> {
    api::delete_issue_relation(&access_token(app, organization_id).await?, relation_id).await
}

pub async fn create_comment(
    app: &AppHandle,
    organization_id: &str,
    issue_id: &str,
    body: &str,
) -> Result<LinearComment> {
    api::create_comment(&access_token(app, organization_id).await?, issue_id, body).await
}

pub async fn update_comment(
    app: &AppHandle,
    organization_id: &str,
    comment_id: &str,
    body: &str,
) -> Result<LinearComment> {
    api::update_comment(&access_token(app, organization_id).await?, comment_id, body).await
}

pub async fn delete_comment(
    app: &AppHandle,
    organization_id: &str,
    comment_id: &str,
) -> Result<()> {
    api::delete_comment(&access_token(app, organization_id).await?, comment_id).await
}

pub async fn update_issue(
    app: &AppHandle,
    organization_id: &str,
    issue_id: &str,
    state_id: Option<&str>,
    assignee_id: Option<&str>,
    clear_assignee: bool,
    cycle_id: Option<&str>,
    clear_cycle: bool,
    priority: Option<u8>,
    label_ids: Option<&[String]>,
    title: Option<&str>,
    description: Option<&str>,
    project_id: Option<&str>,
    clear_project: bool,
    project_milestone_id: Option<&str>,
    clear_project_milestone: bool,
    due_date: Option<&str>,
    clear_due_date: bool,
    estimate: Option<u32>,
    clear_estimate: bool,
) -> Result<Issue> {
    api::update_issue(
        &access_token(app, organization_id).await?,
        issue_id,
        state_id,
        assignee_id,
        clear_assignee,
        cycle_id,
        clear_cycle,
        priority,
        label_ids,
        title,
        description,
        project_id,
        clear_project,
        project_milestone_id,
        clear_project_milestone,
        due_date,
        clear_due_date,
        estimate,
        clear_estimate,
    )
    .await
}

pub fn codex_context(
    app: &AppHandle,
    organization_id: &str,
    issue_id: &str,
) -> Result<LinearCodexContext> {
    let device_id = local_codex_device_id(app)?;
    let bundle = stored_bundle(organization_id)?;
    Ok(LinearCodexContext {
        device_id,
        links: bundle
            .codex_links
            .into_iter()
            .filter(|link| link.issue_id == issue_id)
            .collect(),
        allowed_projects: bundle.codex_project_policy,
    })
}

pub async fn agent_update_issue_state(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    issue_id: &str,
    state_id: &str,
) -> Result<Issue> {
    ensure_agent_project_allowed(organization_id, project_id)?;
    let token = agent_access_token(app, organization_id).await?;
    api::ensure_issue_project(&token, issue_id, project_id).await?;
    api::update_agent_issue_state(&token, issue_id, state_id).await
}

pub async fn agent_create_comment(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    issue_id: &str,
    body: &str,
) -> Result<LinearComment> {
    ensure_agent_project_allowed(organization_id, project_id)?;
    let token = agent_access_token(app, organization_id).await?;
    api::ensure_issue_project(&token, issue_id, project_id).await?;
    api::create_comment(&token, issue_id, body).await
}

fn ensure_agent_project_allowed(organization_id: &str, project_id: &str) -> Result<()> {
    let bundle = stored_bundle(organization_id)?;
    if agent_project_allowed(&bundle.codex_project_policy, project_id) {
        Ok(())
    } else {
        Err(Error::LinearApi(
            "Relay agent is not allowed to work in this Linear project".into(),
        ))
    }
}

fn agent_project_allowed(policies: &[LinearCodexProjectPolicy], project_id: &str) -> bool {
    policies.iter().any(|policy| {
        policy.project_id == project_id
            && policy.allowed
            && policy
                .workspace_repo
                .as_deref()
                .is_some_and(|repo| !repo.trim().is_empty())
    })
}

pub async fn agent_access_token(app: &AppHandle, organization_id: &str) -> Result<String> {
    ensure_not_paused(app, organization_id)?;
    let state = app.state::<LinearState>();
    let _guard = state.refresh.lock().await;
    let mut bundle = stored_bundle(organization_id)?;
    let agent = bundle.agent.clone().ok_or_else(|| {
        Error::LinearApi("Install the Relay agent in this Linear workspace first".into())
    })?;
    if agent.expires_at > oauth::now_seconds().saturating_add(60) {
        return Ok(agent.access_token);
    }
    let agent = match oauth::refresh_agent(agent).await {
        Ok(agent) => agent,
        Err(refresh_error) => {
            let remote = if crate::nexus_auth::status().is_ok_and(|status| status.connected) {
                nexus_sync::discover(app)
                    .await
                    .ok()
                    .and_then(|connections| {
                        connections.into_iter().find_map(|(_, connection, bundle)| {
                            (connection.organization_id == organization_id)
                                .then_some(bundle.agent)
                                .flatten()
                                .filter(|agent| {
                                    agent.expires_at > oauth::now_seconds().saturating_add(60)
                                })
                        })
                    })
            } else {
                None
            };
            remote.ok_or(refresh_error)?
        }
    };
    bundle.agent = Some(agent.clone());
    save_bundle(organization_id, &bundle)?;
    if crate::nexus_auth::status().is_ok_and(|status| status.connected) {
        if let Some(connection) = connections(app)?
            .into_iter()
            .find(|connection| connection.organization_id == organization_id)
        {
            let _ = nexus_sync::persist(app, &connection, &bundle).await;
        }
    }
    Ok(agent.access_token)
}

pub async fn set_codex_project_allowed(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    allowed: bool,
    workspace_repo: Option<&str>,
) -> Result<()> {
    if project_id.trim().is_empty()
        || workspace_repo.is_some_and(|repo| repo.trim().is_empty())
        || (allowed && workspace_repo.is_none())
    {
        return Err(Error::LinearApi(
            "Linear project and linked repository are required".into(),
        ));
    }
    update_bundle(app, organization_id, |bundle| {
        bundle
            .codex_project_policy
            .retain(|policy| policy.project_id != project_id);
        bundle
            .codex_project_policy
            .push(oauth::LinearCodexProjectPolicy {
                project_id: project_id.to_owned(),
                allowed,
                workspace_repo: workspace_repo.map(str::to_owned),
                updated_at: oauth::now_seconds(),
            });
    })
    .await
}

pub async fn save_codex_link(
    app: &AppHandle,
    organization_id: &str,
    issue_id: &str,
    workspace_repo: &str,
    workspace_name: &str,
    thread_id: &str,
) -> Result<()> {
    if issue_id.trim().is_empty()
        || workspace_repo.trim().is_empty()
        || workspace_name.trim().is_empty()
        || thread_id.trim().is_empty()
    {
        return Err(Error::LinearApi(
            "Linear and Codex link details are required".into(),
        ));
    }
    let device_id = local_codex_device_id(app)?;
    update_bundle(app, organization_id, |bundle| {
        bundle
            .codex_links
            .retain(|link| link.issue_id != issue_id || link.device_id != device_id);
        bundle.codex_links.push(LinearCodexLink {
            issue_id: issue_id.to_owned(),
            device_id,
            workspace_repo: workspace_repo.to_owned(),
            workspace_name: workspace_name.to_owned(),
            thread_id: thread_id.to_owned(),
            updated_at: oauth::now_seconds(),
        });
    })
    .await
}

async fn update_bundle(
    app: &AppHandle,
    organization_id: &str,
    update: impl FnOnce(&mut TokenBundle),
) -> Result<()> {
    let _ = access_token(app, organization_id).await?;
    let state = app.state::<LinearState>();
    let _guard = state.refresh.lock().await;
    let mut bundle = stored_bundle(organization_id)?;
    update(&mut bundle);
    let encoded =
        serde_json::to_string(&bundle).map_err(|error| Error::LinearApi(error.to_string()))?;
    token_entry(organization_id)?
        .set_password(&encoded)
        .map_err(|error| Error::SecretStoreUnavailable(error.to_string()))?;
    if crate::nexus_auth::status().is_ok_and(|status| status.connected) {
        if let Some(connection) = connections(app)?
            .into_iter()
            .find(|connection| connection.organization_id == organization_id)
        {
            nexus_sync::persist(app, &connection, &bundle).await?;
        }
    }
    Ok(())
}

fn stored_bundle(organization_id: &str) -> Result<TokenBundle> {
    let encoded = token_entry(organization_id)?
        .get_password()
        .map_err(|error| Error::SecretStoreUnavailable(error.to_string()))?;
    serde_json::from_str(&encoded)
        .map_err(|_| Error::LinearApi("stored Linear credentials are invalid".into()))
}

fn save_bundle(organization_id: &str, bundle: &TokenBundle) -> Result<()> {
    token_entry(organization_id)?
        .set_password(
            &serde_json::to_string(bundle).map_err(|error| Error::LinearApi(error.to_string()))?,
        )
        .map_err(|error| Error::SecretStoreUnavailable(error.to_string()))
}

fn local_codex_device_id(app: &AppHandle) -> Result<String> {
    let state = app.state::<LinearState>();
    let mut cached = state
        .device_id
        .lock()
        .map_err(|_| Error::LinearApi("Codex device identity is unavailable".into()))?;
    if let Some(id) = cached.as_ref() {
        return Ok(id.clone());
    }
    let store = app
        .store("settings.json")
        .map_err(|error| Error::LinearApi(error.to_string()))?;
    let id = store
        .get(CODEX_DEVICE_ID_KEY)
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| oauth::random_token(24));
    store.set(CODEX_DEVICE_ID_KEY, serde_json::Value::String(id.clone()));
    store
        .save()
        .map_err(|error| Error::LinearApi(error.to_string()))?;
    *cached = Some(id.clone());
    Ok(id)
}

pub async fn my_issues(
    app: &AppHandle,
    organization_id: &str,
    search: Option<&str>,
    after: Option<&str>,
    include_archived: bool,
    state_id: Option<&str>,
    priority: Option<u8>,
    label_id: Option<&str>,
) -> Result<IssuePage> {
    let connection = connections(app)?
        .into_iter()
        .find(|connection| connection.organization_id == organization_id)
        .ok_or_else(|| Error::LinearApi("Linear workspace is not connected".into()))?;
    api::my_issues(
        &access_token(app, organization_id).await?,
        &connection.viewer_id,
        search,
        after,
        include_archived,
        state_id,
        priority,
        label_id,
    )
    .await
}

pub async fn team_issues(
    app: &AppHandle,
    organization_id: &str,
    team_id: &str,
    search: Option<&str>,
    after: Option<&str>,
    include_archived: bool,
    state_id: Option<&str>,
    priority: Option<u8>,
    assignee_id: Option<&str>,
    label_id: Option<&str>,
    cycle_id: Option<&str>,
) -> Result<IssuePage> {
    api::team_issues(
        &access_token(app, organization_id).await?,
        team_id,
        search,
        after,
        include_archived,
        state_id,
        priority,
        assignee_id,
        label_id,
        cycle_id,
    )
    .await
}

pub async fn archive_issue(app: &AppHandle, organization_id: &str, issue_id: &str) -> Result<()> {
    api::archive_issue(&access_token(app, organization_id).await?, issue_id).await
}

pub async fn unarchive_issue(app: &AppHandle, organization_id: &str, issue_id: &str) -> Result<()> {
    api::unarchive_issue(&access_token(app, organization_id).await?, issue_id).await
}

pub async fn project_issues(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    after: Option<&str>,
    include_archived: bool,
    search: Option<&str>,
    state_id: Option<&str>,
    priority: Option<u8>,
    assignee_id: Option<&str>,
    label_id: Option<&str>,
) -> Result<IssuePage> {
    api::project_issues(
        &access_token(app, organization_id).await?,
        project_id,
        after,
        include_archived,
        search,
        state_id,
        priority,
        assignee_id,
        label_id,
    )
    .await
}

async fn access_token(app: &AppHandle, organization_id: &str) -> Result<String> {
    ensure_not_paused(app, organization_id)?;
    // ponytail: one lock keeps rotating refresh tokens from racing across workspaces; split by workspace if refreshes queue.
    let state = app.state::<LinearState>();
    let _guard = state.refresh.lock().await;
    let entry = token_entry(organization_id)?;
    let encoded = entry
        .get_password()
        .map_err(|error| Error::SecretStoreUnavailable(error.to_string()))?;
    let mut bundle: TokenBundle = serde_json::from_str(&encoded)
        .map_err(|_| Error::LinearApi("stored Linear credentials are invalid".into()))?;
    if bundle.expires_at <= oauth::now_seconds().saturating_add(60) {
        bundle = match oauth::refresh(bundle).await {
            Ok(bundle) => bundle,
            Err(refresh_error) => {
                let current = if crate::nexus_auth::status().is_ok_and(|status| status.connected) {
                    nexus_sync::discover(app)
                        .await
                        .ok()
                        .and_then(|connections| {
                            nexus_sync::current_bundle_for(
                                connections,
                                organization_id,
                                oauth::now_seconds(),
                            )
                        })
                } else {
                    None
                };
                match current {
                    Some(bundle) => bundle,
                    None => return Err(refresh_error),
                }
            }
        };
        entry
            .set_password(
                &serde_json::to_string(&bundle)
                    .map_err(|error| Error::LinearApi(error.to_string()))?,
            )
            .map_err(|error| Error::SecretStoreUnavailable(error.to_string()))?;
        if crate::nexus_auth::status().is_ok_and(|status| status.connected) {
            if let Some(connection) = connections(app)?
                .into_iter()
                .find(|connection| connection.organization_id == organization_id)
            {
                let _ = nexus_sync::persist(app, &connection, &bundle).await;
            }
        }
    }
    Ok(bundle.access_token)
}

fn token_entry(organization_id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new("relay-linear", organization_id)
        .map_err(|error| Error::SecretStoreUnavailable(error.to_string()))
}

fn save_connected(app: &AppHandle, bundle: TokenBundle, viewer: Viewer) -> Result<()> {
    let entry = token_entry(&viewer.organization.id)?;
    entry
        .set_password(
            &serde_json::to_string(&bundle).map_err(|error| Error::LinearApi(error.to_string()))?,
        )
        .map_err(|error| Error::SecretStoreUnavailable(error.to_string()))?;
    save_connection(
        app,
        LinearConnection {
            organization_id: viewer.organization.id,
            organization_name: viewer.organization.name,
            url_key: viewer.organization.url_key,
            viewer_id: viewer.id,
            viewer_name: viewer.name,
            viewer_email: viewer.email,
            nexus_credential_id: None,
            agent_installed: false,
            paused_on_device: false,
        },
    )
}

fn save_connections(app: &AppHandle, connections: Vec<LinearConnection>) -> Result<()> {
    let store = app
        .store("settings.json")
        .map_err(|error| Error::LinearApi(error.to_string()))?;
    store.set(
        CONNECTIONS_KEY,
        serde_json::to_value(connections).map_err(|error| Error::LinearApi(error.to_string()))?,
    );
    store
        .save()
        .map_err(|error| Error::LinearApi(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        agent_project_allowed, update_paused_on_device, update_pending_revoke,
        LinearCodexProjectPolicy,
    };

    #[test]
    fn device_pause_is_idempotent_and_only_changes_the_requested_workspace() {
        let mut paused = vec!["org-1".to_owned()];
        update_paused_on_device(&mut paused, "org-1", true);
        update_paused_on_device(&mut paused, "org-2", true);
        update_paused_on_device(&mut paused, "org-1", false);
        assert_eq!(paused, ["org-2"]);
    }

    #[test]
    fn failed_revokes_queue_once_and_successful_retries_clear_them() {
        let mut pending = Vec::new();
        update_pending_revoke(&mut pending, "org-1", false);
        update_pending_revoke(&mut pending, "org-1", false);
        assert_eq!(pending, vec!["org-1".to_owned()]);

        update_pending_revoke(&mut pending, "org-1", true);
        assert!(pending.is_empty());
    }

    #[test]
    fn relay_agent_projects_are_default_deny_and_require_an_explicit_repository() {
        assert!(!agent_project_allowed(&[], "project-1"));
        assert!(!agent_project_allowed(
            &[LinearCodexProjectPolicy {
                project_id: "project-1".into(),
                allowed: true,
                workspace_repo: None,
                updated_at: 1,
            }],
            "project-1"
        ));
        assert!(agent_project_allowed(
            &[LinearCodexProjectPolicy {
                project_id: "project-1".into(),
                allowed: true,
                workspace_repo: Some("org/repo".into()),
                updated_at: 1,
            }],
            "project-1"
        ));
    }
}
