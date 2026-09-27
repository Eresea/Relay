mod api;
mod nexus_sync;
mod oauth;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};

pub use api::{
    Initiative, Issue, IssueDetail, IssuePage, LinearComment, LinearCycle, LinearMilestone,
    LinearProject, Person, Team, Viewer, WorkflowState,
};
use oauth::TokenBundle;

const CONNECTIONS_KEY: &str = "linear.connections";

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
}

#[derive(Default)]
pub struct LinearState {
    pending: std::sync::Mutex<Option<oauth::PendingAuth>>,
    refresh: tokio::sync::Mutex<()>,
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

pub fn oauth_configured() -> bool {
    oauth::configured()
}

pub async fn handle_callback(app: AppHandle, url: url::Url) {
    oauth::handle_callback(app, url).await;
}

pub async fn status(app: &AppHandle) -> Result<Vec<LinearConnection>> {
    if crate::nexus_auth::status().is_ok_and(|status| status.connected) {
        if let Ok(remote) = nexus_sync::discover(app).await {
            let remote_ids = remote
                .iter()
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
    connections(app)
}

pub async fn disconnect(app: &AppHandle, organization_id: &str) -> Result<()> {
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
    store.set(
        CONNECTIONS_KEY,
        serde_json::to_value(connections).map_err(|error| Error::LinearApi(error.to_string()))?,
    );
    store
        .save()
        .map_err(|error| Error::LinearApi(error.to_string()))?;
    remote_revoke
}

pub async fn teams(app: &AppHandle, organization_id: &str) -> Result<Vec<Team>> {
    api::teams(&access_token(app, organization_id).await?).await
}

pub async fn users(app: &AppHandle, organization_id: &str) -> Result<Vec<Person>> {
    api::users(&access_token(app, organization_id).await?).await
}

pub async fn projects(app: &AppHandle, organization_id: &str) -> Result<Vec<LinearProject>> {
    api::projects(&access_token(app, organization_id).await?).await
}

pub async fn create_project(
    app: &AppHandle,
    organization_id: &str,
    team_id: &str,
    name: &str,
    description: Option<&str>,
) -> Result<LinearProject> {
    api::create_project(
        &access_token(app, organization_id).await?,
        team_id,
        name,
        description,
    )
    .await
}

pub async fn update_project(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    name: &str,
    description: &str,
) -> Result<LinearProject> {
    api::update_project(
        &access_token(app, organization_id).await?,
        project_id,
        name,
        description,
    )
    .await
}

pub async fn project_milestones(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
) -> Result<Vec<LinearMilestone>> {
    api::project_milestones(&access_token(app, organization_id).await?, project_id).await
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

pub async fn initiatives(app: &AppHandle, organization_id: &str) -> Result<Vec<Initiative>> {
    api::initiatives(&access_token(app, organization_id).await?).await
}

pub async fn cycles(
    app: &AppHandle,
    organization_id: &str,
    team_id: &str,
) -> Result<Vec<LinearCycle>> {
    api::cycles(&access_token(app, organization_id).await?, team_id).await
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
    project_id: Option<&str>,
    project_milestone_id: Option<&str>,
    parent_id: Option<&str>,
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
        Some(&viewer_id),
        project_id,
        project_milestone_id,
        parent_id,
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

pub async fn create_comment(
    app: &AppHandle,
    organization_id: &str,
    issue_id: &str,
    body: &str,
) -> Result<LinearComment> {
    api::create_comment(&access_token(app, organization_id).await?, issue_id, body).await
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
    )
    .await
}

pub async fn my_issues(
    app: &AppHandle,
    organization_id: &str,
    after: Option<&str>,
) -> Result<IssuePage> {
    let connection = connections(app)?
        .into_iter()
        .find(|connection| connection.organization_id == organization_id)
        .ok_or_else(|| Error::LinearApi("Linear workspace is not connected".into()))?;
    api::my_issues(
        &access_token(app, organization_id).await?,
        &connection.viewer_id,
        after,
    )
    .await
}

pub async fn project_issues(
    app: &AppHandle,
    organization_id: &str,
    project_id: &str,
    after: Option<&str>,
) -> Result<IssuePage> {
    api::project_issues(
        &access_token(app, organization_id).await?,
        project_id,
        after,
    )
    .await
}

async fn access_token(app: &AppHandle, organization_id: &str) -> Result<String> {
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
        bundle = oauth::refresh(bundle).await?;
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
