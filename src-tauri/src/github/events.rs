use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::error::{Error, Result};
use crate::events::{AppEvent, NotificationAction, NotificationStatus, INFO_AUTO_DISMISS_MS};
use crate::nexus_auth;
use crate::notifications::{self, NotificationRecord};
use tauri_plugin_store::StoreExt;

use super::nexus_store::NexusGitHubTokenStore;
use super::rules::{should_notify, PrEventKind};
use super::token_store::TokenStore;

const NEXUS: &str = "https://nexus.eresea.net/api/v1";
const INBOX_INTERVAL: Duration = Duration::from_secs(20);
const NEXUS_WS: &str = "wss://nexus.eresea.net/ws/v1/user";
const WEBHOOKS_KEY: &str = "github.webhooks";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredWebhook {
    endpoint_id: String,
    hook_id: u64,
}

#[derive(Deserialize)]
struct CreatedEndpoint {
    endpoint_id: String,
    signing_secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxResponse {
    events: Vec<InboxEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxEvent {
    id: String,
    claim_token: String,
    event_type: String,
    payload: Value,
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
    title: String,
    html_url: String,
    merged: bool,
    base: Base,
}

#[derive(Deserialize)]
struct Base {
    #[serde(rename = "ref")]
    branch: String,
}

pub fn start(app: AppHandle) {
    let inbox_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("Nexus event client configuration is valid");
        loop {
            if let Err(error) = poll_once(&inbox_app, &http).await {
                log::warn!("Nexus event inbox poll failed: {error}");
            }
            tokio::time::sleep(INBOX_INTERVAL).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        websocket_loop(app).await;
    });
}

async fn websocket_loop(app: AppHandle) {
    loop {
        let connected = connect_and_drain(&app).await;
        if let Err(error) = connected {
            log::debug!("Nexus realtime connection ended: {error}");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn connect_and_drain(app: &AppHandle) -> Result<()> {
    let token = nexus_auth::access_token(app).await?;
    let mut request = NEXUS_WS
        .into_client_request()
        .map_err(|error| Error::NexusAuth(error.to_string()))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|error| Error::NexusAuth(error.to_string()))?,
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| Error::NexusAuth(error.to_string()))?;
    let mut auth_check = tokio::time::interval(Duration::from_secs(30));
    auth_check.tick().await;
    loop {
        tokio::select! {
            message = socket.next() => {
                let Some(message) = message else { return Ok(()); };
                match message.map_err(|error| Error::NexusAuth(error.to_string()))? {
                    Message::Text(text) => {
                        let available = serde_json::from_str::<serde_json::Value>(&text)
                            .ok()
                            .and_then(|event| event.get("type").and_then(Value::as_str).map(str::to_owned))
                            .is_some_and(|kind| kind == "events.available");
                        if available {
                            let http = reqwest::Client::builder()
                                .redirect(reqwest::redirect::Policy::none())
                                .build()
                                .map_err(|error| Error::NexusAuth(error.to_string()))?;
                            poll_once(app, &http).await?;
                        }
                    }
                    Message::Ping(payload) => {
                        socket.send(Message::Pong(payload)).await
                            .map_err(|error| Error::NexusAuth(error.to_string()))?;
                    }
                    Message::Close(_) => return Ok(()),
                    _ => {}
                }
            }
            _ = auth_check.tick() => {
                if !matches!(nexus_auth::access_token(app).await, Ok(active) if active == token) {
                    return Ok(());
                }
            }
        }
    }
}

pub async fn register(app: &AppHandle, repositories: Vec<String>) -> Result<Vec<String>> {
    let github_token = NexusGitHubTokenStore::new(app.clone())
        .get()
        .await?
        .ok_or_else(|| Error::NexusAuth("connect GitHub before registering webhooks".into()))?;
    let nexus_token = nexus_auth::access_token(app).await?;
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
            continue;
        }
        let endpoint: CreatedEndpoint = http_json(
            reqwest::Client::new()
                .post(format!("{NEXUS}/events/endpoints"))
                .bearer_auth(&nexus_token)
                .json(&serde_json::json!({
                    "signatureMode": "hmac-sha256-raw-body",
                    "signatureHeader": "X-Hub-Signature-256",
                    "deliveryIdHeader": "X-GitHub-Delivery",
                    "eventTypeHeader": "X-GitHub-Event"
                })),
        )
        .await
        .map_err(nexus_http_error)?;
        let callback = format!(
            "https://nexus.eresea.net/api/v1/events/ingress/{}",
            endpoint.endpoint_id
        );
        let hooks_url = format!("https://api.github.com/repos/{owner}/{name}/hooks");
        #[derive(Deserialize)]
        struct CreatedHook {
            id: u64,
        }
        let created: CreatedHook = match http_json(
            reqwest::Client::new()
                .post(&hooks_url)
                .bearer_auth(&github_token.access_token)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .json(&serde_json::json!({
                    "name": "web",
                    "active": true,
                    "events": ["pull_request"],
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
                let _ = reqwest::Client::new()
                    .delete(format!("{NEXUS}/events/endpoints/{}", endpoint.endpoint_id))
                    .bearer_auth(&nexus_token)
                    .send()
                    .await;
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
        .get()
        .await?
        .ok_or_else(|| Error::NexusAuth("connect GitHub to remove its webhook".into()))?;
    let nexus_token = nexus_auth::access_token(app).await?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| Error::GithubRequestFailed(error.to_string()))?;
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
    let response = client
        .delete(format!("{NEXUS}/events/endpoints/{}", webhook.endpoint_id))
        .bearer_auth(&nexus_token)
        .send()
        .await
        .map_err(|error| Error::NexusAuth(error.to_string()))?;
    if response.status() != reqwest::StatusCode::NOT_FOUND {
        response.error_for_status().map_err(nexus_http_error)?;
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

fn nexus_http_error(error: reqwest::Error) -> Error {
    Error::NexusAuth(format!(
        "Nexus webhook endpoint request failed ({})",
        error
            .status()
            .map_or("network error".into(), |status| status.to_string())
    ))
}

fn github_http_error(error: reqwest::Error) -> Error {
    Error::GithubRequestFailed(format!(
        "GitHub webhook request failed ({})",
        error
            .status()
            .map_or("network error".into(), |status| status.to_string())
    ))
}

async fn poll_once(app: &AppHandle, http: &reqwest::Client) -> Result<()> {
    let token = match nexus_auth::access_token(app).await {
        Ok(token) => token,
        Err(_) => return Ok(()),
    };
    let response = http
        .post(format!("{NEXUS}/events/inbox/claim"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "limit": 10 }))
        .send()
        .await
        .map_err(|error| Error::NexusAuth(error.to_string()))?
        .error_for_status()
        .map_err(|error| Error::NexusAuth(error.to_string()))?;
    let inbox: InboxResponse = response
        .json()
        .await
        .map_err(|error| Error::NexusAuth(error.to_string()))?;

    for event in inbox.events {
        if let Err(error) = process_event(app, http, &token, &event).await {
            log::warn!("could not process Nexus event {}: {error}", event.id);
        }
    }
    Ok(())
}

async fn process_event(
    app: &AppHandle,
    http: &reqwest::Client,
    token: &str,
    event: &InboxEvent,
) -> Result<()> {
    if !valid_event_id(&event.id) || event.claim_token.is_empty() {
        return Err(Error::NexusAuth(
            "Nexus returned an invalid event claim".into(),
        ));
    }
    if notifications::webhook_processed(app, &event.id)? {
        return acknowledge(http, token, event).await;
    }
    if let Some((repo, branch, number, _title, _url, kind)) = interpret(event) {
        let credential = NexusGitHubTokenStore::new(app.clone())
            .get()
            .await?
            .ok_or_else(|| Error::NexusAuth("GitHub credential is unavailable".into()))?;
        let client = app
            .state::<super::client::HttpGitHubClient>()
            .inner()
            .clone();
        let snapshot = super::poll::refresh_from_webhook(
            app,
            &client,
            &credential.access_token,
            &credential.username,
            &repo,
            number,
        )
        .await?;
        let settings = super::read_settings(app);
        if should_notify(&settings, &repo, &branch, number, kind)
            && (kind != PrEventKind::ReviewRequested || snapshot.review_requested)
        {
            let notification_id = format!("{repo}#{number}:{kind:?}");
            let record = NotificationRecord {
                notification_id: notification_id.clone(),
                job_id: notification_id.clone(),
                hue_source: "github".into(),
                title: event_title(kind).into(),
                detail: Some(format!("{repo}#{number} · {}", snapshot.title)),
                icon: None,
                status: NotificationStatus::Done,
                progress: None,
                auto_dismiss_ms: Some(INFO_AUTO_DISMISS_MS),
                actions: vec![NotificationAction::Open {
                    label: "Open".into(),
                    url: snapshot.url,
                }],
                read: false,
                created_at: now_millis(),
            };
            if notifications::persist_webhook(app, &event.id, &record)? {
                crate::events::EventSink::emit(
                    app,
                    AppEvent::Notification {
                        notification_id,
                        job_id: crate::jobs::JobId::from(record.job_id.clone()),
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
        } else {
            notifications::ignore_webhook(app, &event.id)?;
        }
    } else {
        notifications::ignore_webhook(app, &event.id)?;
    }
    acknowledge(http, token, event).await
}

fn valid_event_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

fn interpret(event: &InboxEvent) -> Option<(String, String, u64, String, String, PrEventKind)> {
    if event.event_type != "pull_request" {
        return None;
    }
    let payload: PullRequestPayload = serde_json::from_value(event.payload.clone()).ok()?;
    let kind = match payload.action.as_str() {
        "opened" | "reopened" => PrEventKind::Opened,
        "closed" if payload.pull_request.merged => PrEventKind::Merged,
        "closed" => PrEventKind::Closed,
        "review_requested" => PrEventKind::ReviewRequested,
        _ => return None,
    };
    Some((
        payload.repository.full_name,
        payload.pull_request.base.branch,
        payload.pull_request.number,
        payload.pull_request.title,
        payload.pull_request.html_url,
        kind,
    ))
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

async fn acknowledge(http: &reqwest::Client, token: &str, event: &InboxEvent) -> Result<()> {
    http.post(format!("{NEXUS}/events/inbox/{}/ack", event.id))
        .bearer_auth(token)
        .json(&serde_json::json!({ "claimToken": event.claim_token }))
        .send()
        .await
        .map_err(|error| Error::NexusAuth(error.to_string()))?
        .error_for_status()
        .map_err(|error| Error::NexusAuth(error.to_string()))?;
    Ok(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
