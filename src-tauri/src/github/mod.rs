//! The GitHub connector: connect an account over OAuth Device Flow, then
//! consume repository webhook events through the Nexus inbox.
//!
//! Three concerns, three files: `oauth` and `client` know how to talk to
//! GitHub (device flow, search, pull request detail, check runs);
//! `token_store` knows where the access token lives at rest; `rules` and
//! `poll` know what to do with what comes back — which changes matter to
//! this user, and what changed since the last look. This file is the thin
//! layer that wires those pieces to real Tauri state and starts/stops the
//! recurring job.

pub mod client;
pub mod events;
pub mod nexus_store;
pub mod oauth;
pub mod poll;
pub mod rules;
pub mod token_store;

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};
use crate::events::{NotificationAction, NotificationStatus};
use crate::jobs::{self, JobRegistry, NotificationOptions};

use client::{GitHubClient, HttpGitHubClient, RepositorySummary};
use nexus_store::NexusGitHubTokenStore;
use oauth::DeviceAuthorization;
use poll::PullRequestSnapshot;
use rules::GithubConnectorSettings;
use token_store::TokenStore;

const SETTINGS_KEY: &str = "github.settings";
const POLL_CACHE_FILE: &str = "github-poll-cache.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub connected: bool,
    pub username: Option<String>,
    pub nexus_credential_ready: bool,
}

/// Whether an account is connected, and whether its token is shared through Nexus.
pub async fn status(app: &AppHandle) -> Result<GithubStatus> {
    let (username, nexus_credential_ready) = NexusGitHubTokenStore::new(app.clone())
        .connection_state()
        .await?;
    Ok(GithubStatus {
        connected: username.is_some(),
        username,
        nexus_credential_ready,
    })
}

/// Returns the signed-in user's recent repositories. An unconnected account
/// is a valid empty result so the Projects surface can still show local-only
/// clones without inventing a separate auth state.
pub async fn repositories(
    app: &AppHandle,
    client: HttpGitHubClient,
) -> Result<Vec<RepositorySummary>> {
    let Some(token) = NexusGitHubTokenStore::new(app.clone()).get_valid().await? else {
        return Ok(Vec::new());
    };
    client.list_repositories(&token.access_token).await
}

pub fn pull_requests(app: &AppHandle, include_closed: bool) -> Result<Vec<PullRequestSnapshot>> {
    Ok(poll::recent_pull_requests(
        &poll_cache_path(app),
        include_closed,
    ))
}

/// Starts a Device Flow login: requests a code from GitHub (one blocking
/// round trip — see `jobs::mod`'s note on why commands stay synchronous and
/// reach for `async_runtime::block_on` rather than becoming async
/// themselves), then hands the wait for the user's approval to a background
/// job so this command can return immediately with the code to display.
/// Fails fast, with no network call at all, if no OAuth App client id has
/// been configured — a request sent without one reaches GitHub only to come
/// back as an opaque 404.
pub fn connect_start(
    app: AppHandle,
    client: HttpGitHubClient,
    registry: JobRegistry,
) -> Result<DeviceAuthorization> {
    log::info!("github: connect_start called");
    let settings = read_settings(&app);
    let client_id = match rules::effective_client_id(&settings) {
        Some(id) => id.to_string(),
        None => {
            log::warn!("github: connect_start called with no client id configured");
            return Err(Error::GithubClientIdNotConfigured);
        }
    };

    log::info!("github: requesting a device code");
    let device = match tauri::async_runtime::block_on(client.start_device_flow(&client_id)) {
        Ok(device) => device,
        Err(error) => {
            log::error!("github: start_device_flow failed: {error}");
            return Err(error);
        }
    };
    log::info!(
        "github: got a device code, expires in {}s, poll every {}s",
        device.expires_in,
        device.poll_interval_secs()
    );
    let user_code = device.user_code.clone();
    let verification_uri = device.verification_uri.clone();
    let expires_in = device.expires_in;

    let job_client = client.clone();
    let job_app = app.clone();
    let sink = app.clone();
    let job_id = jobs::spawn(sink, registry, "github", move |ctx| async move {
        log::info!("github: connect job started");
        ctx.report_notification(
            NotificationStatus::Waiting,
            "Waiting for GitHub authorization",
            Some(format!(
                "Enter {} at {}",
                device.user_code, device.verification_uri
            )),
            None,
            NotificationOptions {
                notification_id: "github-auth".to_string(),
                auto_dismiss_ms: None,
                actions: vec![NotificationAction::Cancel {
                    label: "Cancel".to_string(),
                }],
            },
        );
        let token_store = NexusGitHubTokenStore::new(job_app.clone());
        let result =
            poll::run_device_flow(&ctx, &job_client, &token_store, &client_id, device).await;
        let stored = match result {
            Ok(stored) => stored,
            Err(error) => {
                log::error!("github: connect job failed: {error}");
                return Err(error);
            }
        };
        log::info!("github: connected as {}", stored.username);
        ctx.report(
            NotificationStatus::Done,
            format!("Connected to GitHub as {}", stored.username),
            None,
            None,
        );
        Ok(())
    });
    log::info!("github: connect job spawned as {job_id}");

    Ok(DeviceAuthorization {
        user_code,
        verification_uri,
        expires_in,
        job_id: job_id.to_string(),
    })
}

/// Removes registered hooks, the GitHub credential, and the local PR cache.
pub async fn disconnect(app: &AppHandle) -> Result<()> {
    events::unregister_all(app).await?;
    NexusGitHubTokenStore::new(app.clone()).clear().await?;
    let _ = std::fs::remove_file(poll_cache_path(app));
    Ok(())
}

fn read_settings(app: &AppHandle) -> GithubConnectorSettings {
    let settings: GithubConnectorSettings = app
        .store("settings.json")
        .ok()
        .and_then(|store| store.get(SETTINGS_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    settings
}

fn poll_cache_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(POLL_CACHE_FILE)
}
