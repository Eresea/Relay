//! The GitHub connector: connect an account over OAuth Device Flow, then
//! poll for pull request activity on an interval and surface it through the
//! HUD like any other job.
//!
//! Three concerns, three files: `oauth` and `client` know how to talk to
//! GitHub (device flow, search, pull request detail, check runs);
//! `token_store` knows where the access token lives at rest; `rules` and
//! `poll` know what to do with what comes back — which changes matter to
//! this user, and what changed since the last look. This file is the thin
//! layer that wires those pieces to real Tauri state and starts/stops the
//! recurring job.

pub mod client;
pub mod oauth;
pub mod poll;
pub mod rules;
pub mod token_store;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};
use crate::events::{NotificationAction, NotificationStatus};
use crate::jobs::{self, JobId, JobRegistry, NotificationOptions};

use client::{GitHubClient, HttpGitHubClient};
use oauth::DeviceAuthorization;
use rules::GithubConnectorSettings;
use token_store::{KeyringTokenStore, TokenStore};

const SETTINGS_KEY: &str = "github.settings";
const POLL_CACHE_FILE: &str = "github-poll-cache.json";

/// Tracks the one long-running poll job so `disconnect` can cancel it.
/// Nothing else about the connection is kept here — the token lives in the
/// keychain and the rules live in `settings.json`, both readable fresh
/// whenever they're needed.
#[derive(Default)]
pub struct GithubState {
    poll_job: Mutex<Option<JobId>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub connected: bool,
    pub username: Option<String>,
}

/// Whether an account is connected. Cheap and synchronous — it only reads
/// the keychain, never calls GitHub.
pub fn status() -> Result<GithubStatus> {
    log::info!("github: status() called");
    match KeyringTokenStore.get()? {
        Some(token) => Ok(GithubStatus {
            connected: true,
            username: Some(token.username),
        }),
        None => Ok(GithubStatus {
            connected: false,
            username: None,
        }),
    }
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
    let job_registry = registry.clone();
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
        let token_store = KeyringTokenStore;
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
        start_polling(&job_app, job_client, &job_registry);
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

/// Cancels the poll job, if one is running, and removes the token from the
/// keychain. The on-disk PR cache is also removed so a future reconnect
/// starts from a clean slate rather than diffing against months-old state.
pub fn disconnect(app: &AppHandle, registry: &JobRegistry) -> Result<()> {
    KeyringTokenStore.clear()?;
    if let Some(job_id) = app.state::<GithubState>().poll_job.lock().unwrap().take() {
        let _ = registry.cancel(&job_id);
    }
    let _ = std::fs::remove_file(poll_cache_path(app));
    Ok(())
}

/// Called once at startup: if a token is already in the keychain from a
/// previous session, resume polling without requiring the user to
/// reconnect.
pub fn resume_polling_if_connected(
    app: &AppHandle,
    client: HttpGitHubClient,
    registry: &JobRegistry,
) {
    match KeyringTokenStore.get() {
        Ok(Some(_)) => start_polling(app, client, registry),
        Ok(None) => {}
        Err(error) => log::warn!("could not check the GitHub connection at startup: {error}"),
    }
}

fn start_polling(app: &AppHandle, client: HttpGitHubClient, registry: &JobRegistry) {
    let token_store = Arc::new(KeyringTokenStore);
    let sink = app.clone();
    let cache_path = poll_cache_path(app);
    let settings_app = app.clone();
    let job_registry = registry.clone();

    let job_id = jobs::spawn(sink.clone(), registry.clone(), "github", move |ctx| {
        poll::run_poll_loop(
            ctx,
            client,
            token_store,
            job_registry,
            sink,
            cache_path,
            move || read_settings(&settings_app),
        )
    });

    *app.state::<GithubState>().poll_job.lock().unwrap() = Some(job_id);
}

fn read_settings(app: &AppHandle) -> GithubConnectorSettings {
    let mut settings: GithubConnectorSettings = app
        .store("settings.json")
        .ok()
        .and_then(|store| store.get(SETTINGS_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    settings.poll_interval_secs = settings
        .poll_interval_secs
        .max(rules::MIN_POLL_INTERVAL_SECS);
    settings
}

fn poll_cache_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(POLL_CACHE_FILE)
}
