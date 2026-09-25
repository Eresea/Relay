use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};
use crate::events::{
    AppEvent, NotificationAction, NotificationStatus, CHANNEL, INFO_AUTO_DISMISS_MS,
};
use crate::nexus_auth;
use crate::notifications::{self, NotificationRecord};

use super::rules::{should_notify, PrEventKind};

const NEXUS: &str = "https://nexus.eresea.net/api/v1";
const INBOX_INTERVAL: Duration = Duration::from_secs(20);

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
    tauri::async_runtime::spawn(async move {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("Nexus event client configuration is valid");
        loop {
            if let Err(error) = poll_once(&app, &http).await {
                log::warn!("Nexus event inbox poll failed: {error}");
            }
            tokio::time::sleep(INBOX_INTERVAL).await;
        }
    });
}

async fn poll_once(app: &AppHandle, http: &reqwest::Client) -> Result<()> {
    let token = match nexus_auth::access_token(app).await {
        Ok(token) => token,
        Err(_) => return Ok(()),
    };
    let response = http
        .post(format!("{NEXUS}/events/inbox/claim"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "limit": 50 }))
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
        if let Some((repo, branch, number, title, url, kind)) = interpret(&event) {
            let settings = super::read_settings(app);
            if should_notify(&settings, &repo, &branch, number, kind) {
                let notification_id = format!("github:webhook:{}", event.id);
                let record = NotificationRecord {
                    notification_id: notification_id.clone(),
                    job_id: notification_id.clone(),
                    hue_source: "github".into(),
                    title: event_title(kind).into(),
                    detail: Some(format!("{repo}#{number} · {title}")),
                    icon: None,
                    status: NotificationStatus::Done,
                    progress: None,
                    auto_dismiss_ms: Some(INFO_AUTO_DISMISS_MS),
                    actions: vec![NotificationAction::Open {
                        label: "Open".into(),
                        url,
                    }],
                    read: false,
                    created_at: now_millis(),
                };
                if notifications::persist_webhook(app, &event.id, &record)? {
                    if let Err(error) = crate::overlay::show_hud(app) {
                        log::warn!("could not show the HUD for a GitHub event: {error}");
                    }
                    let _ = Emitter::emit(
                        app,
                        CHANNEL,
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
            }
        }
        acknowledge(http, &token, &event).await?;
    }
    Ok(())
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
