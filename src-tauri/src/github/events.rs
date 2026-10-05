use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nexus_client::{
    Error as NexusError, EventEndpointInput, EventsHandle, InboxEvent, NexusClient,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::events::{AppEvent, NotificationAction, NotificationStatus, INFO_AUTO_DISMISS_MS};
use crate::nexus_auth;
use crate::notifications::{self, NotificationRecord};
use tauri_plugin_store::StoreExt;

use super::nexus_store::NexusGitHubTokenStore;
use super::rules::{should_notify, PrEventKind};

const WEBHOOKS_KEY: &str = "github.webhooks";
const WEBHOOK_EVENTS: [&str; 2] = ["pull_request", "check_run"];

fn event_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .expect("GitHub event HTTP client configuration is valid")
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredWebhook {
    endpoint_id: String,
    hook_id: u64,
}

#[derive(Deserialize)]
struct PullRequestPayload {
    action: String,
    repository: Repository,
    pull_request: PullRequest,
}

#[derive(Deserialize)]
struct Repository {
    full_name: String,
}

#[derive(Deserialize)]
struct PullRequest {
    number: u64,
    merged: bool,
    base: Base,
}

#[derive(Deserialize)]
struct Base {
    #[serde(rename = "ref")]
    branch: String,
}

#[derive(Deserialize)]
struct CheckRunPayload {
    action: String,
    repository: Repository,
    check_run: CheckRun,
}

#[derive(Deserialize)]
struct CheckRun {
    #[serde(default)]
    pull_requests: Vec<CheckRunPullRequest>,
}

#[derive(Deserialize)]
struct CheckRunPullRequest {
    number: u64,
    base: Base,
}

enum InterpretedEvent {
    PullRequest {
        repo: String,
        branch: String,
        number: u64,
        kind: PrEventKind,
    },
    CheckRun {
        repo: String,
        pull_requests: Vec<CheckRunPullRequest>,
    },
}

/// Streams this installation's Nexus inbox into [`process_event`]. The SDK
/// drains after every (re)connect and on each wakeup, and acknowledges an
/// event only after `process_event` succeeded, so a delivery is never lost
/// and a failed one is retried. Dropping the handle stops the stream; a
/// `session.revoked` ends the session (the auth watcher then signs the UI out).
pub fn start(app: &AppHandle, client: &NexusClient) -> EventsHandle {
    let sync_app = app.clone();
    tauri::async_runtime::spawn(async move { sync_registered_hooks(&sync_app).await });
    let handler_app = app.clone();
    client.events(move |event| {
        let app = handler_app.clone();
        async move { process_or_give_up(&app, &event).await }
    })
}

/// The SDK stops draining at a failed event and retries from it, so an event
/// that can never succeed (a deleted repository, revoked access) would block
/// every later one. Once it has failed for the whole retry window it is
/// recorded as ignored and reported as handled, letting the cursor move on.
async fn process_or_give_up(app: &AppHandle, event: &InboxEvent) -> Result<()> {
    let Err(error) = process_event(app, event).await else {
        return Ok(());
    };
    log::warn!("could not process Nexus event {}: {error}", event.id);
    if !notifications::webhook_failed(app, &event.id)? {
        return Err(error);
    }
    log::warn!(
        "giving up on Nexus event {} after repeated failures",
        event.id
    );
    notifications::ignore_webhook(app, &event.id)
}

pub async fn register(app: &AppHandle, repositories: Vec<String>) -> Result<Vec<String>> {
    let github_token = NexusGitHubTokenStore::new(app.clone())
        .get_valid()
        .await?
        .ok_or_else(|| Error::NexusAuth("connect GitHub before registering webhooks".into()))?;
    let nexus = nexus_auth::signed_in_client(app)?;
    let endpoints = nexus.event_endpoints();
    let store = app
        .store("settings.json")
        .map_err(|error| Error::NexusAuth(error.to_string()))?;
    let mut registered: HashMap<String, RegisteredWebhook> = store
        .get(WEBHOOKS_KEY)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let mut completed = Vec::new();

    for repo in repositories {
        let Some((owner, name)) = parse_repository(&repo) else {
            return Err(Error::GithubRequestFailed(format!(
                "invalid repository: {repo}"
            )));
        };
        if registered.contains_key(&repo) {
            ensure_webhook_events(
                &event_http_client(),
                &github_token.access_token,
                owner,
                name,
                registered[&repo].hook_id,
            )
            .await?;
            continue;
        }
        let endpoint = endpoints
            .create(&EventEndpointInput {
                signature_mode: Some("hmac-sha256-raw-body".into()),
                signature_header: Some("X-Hub-Signature-256".into()),
                delivery_id_header: Some("X-GitHub-Delivery".into()),
                event_type_header: Some("X-GitHub-Event".into()),
            })
            .await
            .map_err(nexus_auth::nexus_error)?;
        let callback = format!(
            "{}/events/ingress/{}",
            nexus.config().issuer.trim_end_matches('/'),
            endpoint.endpoint_id
        );
        let hooks_url = format!("https://api.github.com/repos/{owner}/{name}/hooks");
        #[derive(Deserialize)]
        struct CreatedHook {
            id: u64,
        }
        let created: CreatedHook = match http_json(
            event_http_client()
                .post(&hooks_url)
                .bearer_auth(&github_token.access_token)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .json(&serde_json::json!({
                    "name": "web",
                    "active": true,
                    "events": WEBHOOK_EVENTS,
                    "config": {
                        "url": callback,
                        "content_type": "json",
                        "secret": endpoint.signing_secret
                    }
                })),
        )
        .await
        {
            Ok(created) => created,
            Err(error) => {
                let _ = endpoints.revoke(&endpoint.endpoint_id).await;
                return Err(github_http_error(error));
            }
        };
        registered.insert(
            repo.clone(),
            RegisteredWebhook {
                endpoint_id: endpoint.endpoint_id,
                hook_id: created.id,
            },
        );
        store.set(
            WEBHOOKS_KEY,
            serde_json::to_value(&registered).unwrap_or_default(),
        );
        store
            .save()
            .map_err(|error| Error::NexusAuth(error.to_string()))?;
        completed.push(repo);
    }
    Ok(completed)
}

async fn sync_registered_hooks(app: &AppHandle) {
    let github_token = match NexusGitHubTokenStore::new(app.clone()).get_valid().await {
        Ok(Some(token)) => token.access_token,
        _ => return,
    };
    let registered = match app
        .store("settings.json")
        .ok()
        .and_then(|store| store.get(WEBHOOKS_KEY))
        .and_then(|value| serde_json::from_value::<HashMap<String, RegisteredWebhook>>(value).ok())
    {
        Some(registered) => registered,
        None => return,
    };
    let http = event_http_client();
    for (repo, hook) in registered {
        let Some((owner, name)) = parse_repository(&repo) else {
            continue;
        };
        if let Err(error) =
            ensure_webhook_events(&http, &github_token, owner, name, hook.hook_id).await
        {
            log::warn!("could not update GitHub webhook events for {repo}: {error}");
        }
    }
}

async fn ensure_webhook_events(
    http: &reqwest::Client,
    github_token: &str,
    owner: &str,
    name: &str,
    hook_id: u64,
) -> Result<()> {
    http.patch(format!(
        "https://api.github.com/repos/{owner}/{name}/hooks/{hook_id}"
    ))
    .bearer_auth(github_token)
    .header("Accept", "application/vnd.github+json")
    .header("X-GitHub-Api-Version", "2022-11-28")
    .json(&serde_json::json!({ "active": true, "add_events": WEBHOOK_EVENTS }))
    .send()
    .await
    .map_err(|error| Error::GithubRequestFailed(error.to_string()))?
    .error_for_status()
    .map_err(github_http_error)?;
    Ok(())
}

pub fn registered_repositories(app: &AppHandle) -> Result<Vec<String>> {
    let store = app
        .store("settings.json")
        .map_err(|error| Error::NexusAuth(error.to_string()))?;
    let registered: HashMap<String, RegisteredWebhook> = store
        .get(WEBHOOKS_KEY)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    Ok(registered.into_keys().collect())
}

pub async fn unregister(app: &AppHandle, repo: &str) -> Result<()> {
    let Some((owner, name)) = parse_repository(repo) else {
        return Err(Error::GithubRequestFailed(format!(
            "invalid repository: {repo}"
        )));
    };
    let store = app
        .store("settings.json")
        .map_err(|error| Error::NexusAuth(error.to_string()))?;
    let mut registered: HashMap<String, RegisteredWebhook> = store
        .get(WEBHOOKS_KEY)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let Some(webhook) = registered.get(repo) else {
        return Ok(());
    };
    let github_token = NexusGitHubTokenStore::new(app.clone())
        .get_valid()
        .await?
        .ok_or_else(|| Error::NexusAuth("connect GitHub to remove its webhook".into()))?;
    let nexus = nexus_auth::signed_in_client(app)?;
    let client = event_http_client();
    let response = client
        .delete(format!(
            "https://api.github.com/repos/{owner}/{name}/hooks/{}",
            webhook.hook_id
        ))
        .bearer_auth(&github_token.access_token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| Error::GithubRequestFailed(error.to_string()))?;
    if response.status() != reqwest::StatusCode::NOT_FOUND {
        response.error_for_status().map_err(github_http_error)?;
    }
    match nexus.event_endpoints().revoke(&webhook.endpoint_id).await {
        Ok(()) | Err(NexusError::Api { status: 404, .. }) => {}
        Err(error) => return Err(nexus_auth::nexus_error(error)),
    }
    registered.remove(repo);
    store.set(
        WEBHOOKS_KEY,
        serde_json::to_value(registered).unwrap_or_default(),
    );
    store
        .save()
        .map_err(|error| Error::NexusAuth(error.to_string()))
}

pub async fn unregister_all(app: &AppHandle) -> Result<()> {
    for repo in registered_repositories(app)? {
        unregister(app, &repo).await?;
    }
    Ok(())
}

fn parse_repository(repo: &str) -> Option<(&str, &str)> {
    fn valid(part: &str) -> bool {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
    }
    let (owner, name) = repo.split_once('/')?;
    (valid(owner) && valid(name) && !name.contains('/')).then_some((owner, name))
}

async fn http_json<T: for<'de> Deserialize<'de>>(
    request: reqwest::RequestBuilder,
) -> std::result::Result<T, reqwest::Error> {
    request.send().await?.error_for_status()?.json().await
}

fn github_http_error(error: reqwest::Error) -> Error {
    Error::GithubRequestFailed(format!(
        "GitHub webhook request failed ({})",
        error
            .status()
            .map_or("network error".into(), |status| status.to_string())
    ))
}

/// One delivery. The durable marker (processed or ignored) and any
/// notification are written before returning `Ok`, which is what lets the SDK
/// acknowledge the event; a redelivery of a marked event is a no-op.
async fn process_event(app: &AppHandle, event: &InboxEvent) -> Result<()> {
    if notifications::webhook_processed(app, &event.id)? {
        return Ok(());
    }
    let Some(interpreted) = interpret(event) else {
        return notifications::ignore_webhook(app, &event.id);
    };
    let credential = NexusGitHubTokenStore::new(app.clone())
        .get_valid()
        .await?
        .ok_or_else(|| Error::NexusAuth("GitHub credential is unavailable".into()))?;
    let client = app
        .state::<super::client::HttpGitHubClient>()
        .inner()
        .clone();
    let settings = super::read_settings(app);
    let mut records = Vec::new();
    match interpreted {
        InterpretedEvent::PullRequest {
            repo,
            branch,
            number,
            kind,
        } => {
            let (snapshot, _) = super::poll::refresh_from_webhook(
                app,
                &client,
                &credential.access_token,
                &credential.username,
                &repo,
                number,
            )
            .await?;
            if should_notify(&settings, &repo, &branch, number, kind)
                && (kind != PrEventKind::ReviewRequested || snapshot.review_requested)
            {
                records.push(notification_record(
                    &repo,
                    number,
                    kind,
                    &snapshot.title,
                    &snapshot.url,
                ));
            }
        }
        InterpretedEvent::CheckRun {
            repo,
            pull_requests,
        } => {
            for pull_request in pull_requests {
                let (snapshot, changes) = super::poll::refresh_from_webhook(
                    app,
                    &client,
                    &credential.access_token,
                    &credential.username,
                    &repo,
                    pull_request.number,
                )
                .await?;
                for kind in changes
                    .into_iter()
                    .filter(|kind| matches!(kind, PrEventKind::CiFailed | PrEventKind::CiPassed))
                {
                    if should_notify(
                        &settings,
                        &repo,
                        &pull_request.base.branch,
                        pull_request.number,
                        kind,
                    ) {
                        records.push(notification_record(
                            &repo,
                            pull_request.number,
                            kind,
                            &snapshot.title,
                            &snapshot.url,
                        ));
                    }
                }
            }
        }
    }
    if records.is_empty() {
        notifications::ignore_webhook(app, &event.id)?;
    } else if notifications::persist_webhook(app, &event.id, &records)? {
        for record in records {
            emit_notification(app, record);
        }
    }
    Ok(())
}

fn notification_record(
    repo: &str,
    number: u64,
    kind: PrEventKind,
    title: &str,
    url: &str,
) -> NotificationRecord {
    let notification_id = format!("{repo}#{number}:{kind:?}");
    NotificationRecord {
        notification_id: notification_id.clone(),
        job_id: notification_id,
        hue_source: "github".into(),
        title: event_title(kind).into(),
        detail: Some(format!("{repo}#{number} · {title}")),
        icon: None,
        status: NotificationStatus::Done,
        progress: None,
        auto_dismiss_ms: Some(INFO_AUTO_DISMISS_MS),
        actions: vec![NotificationAction::Open {
            label: "Open".into(),
            url: url.to_string(),
        }],
        read: false,
        created_at: now_millis(),
    }
}

fn emit_notification(app: &AppHandle, record: NotificationRecord) {
    crate::events::EventSink::emit(
        app,
        AppEvent::Notification {
            notification_id: record.notification_id,
            job_id: crate::jobs::JobId::from(record.job_id),
            hue_source: record.hue_source,
            title: record.title,
            detail: record.detail,
            icon: record.icon,
            status: record.status,
            progress: record.progress,
            auto_dismiss_ms: record.auto_dismiss_ms,
            actions: record.actions,
        },
    );
}

fn interpret(event: &InboxEvent) -> Option<InterpretedEvent> {
    if event.event_type == "pull_request" {
        let payload: PullRequestPayload = serde_json::from_value(event.payload.clone()).ok()?;
        let kind = match payload.action.as_str() {
            "opened" | "reopened" => PrEventKind::Opened,
            "closed" if payload.pull_request.merged => PrEventKind::Merged,
            "closed" => PrEventKind::Closed,
            "review_requested" => PrEventKind::ReviewRequested,
            _ => return None,
        };
        return Some(InterpretedEvent::PullRequest {
            repo: payload.repository.full_name,
            branch: payload.pull_request.base.branch,
            number: payload.pull_request.number,
            kind,
        });
    }
    if event.event_type == "check_run" {
        let payload: CheckRunPayload = serde_json::from_value(event.payload.clone()).ok()?;
        if payload.action != "completed" || payload.check_run.pull_requests.is_empty() {
            return None;
        }
        return Some(InterpretedEvent::CheckRun {
            repo: payload.repository.full_name,
            pull_requests: payload.check_run.pull_requests,
        });
    }
    None
}

fn event_title(kind: PrEventKind) -> &'static str {
    match kind {
        PrEventKind::Opened => "Pull request opened",
        PrEventKind::Closed => "Pull request closed",
        PrEventKind::Merged => "Pull request merged",
        PrEventKind::ReviewRequested => "Review requested",
        PrEventKind::CiFailed => "CI failed",
        PrEventKind::CiPassed => "CI passed",
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
