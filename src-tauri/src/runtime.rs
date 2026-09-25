use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

use crate::error::{Error, Result};

const SERVICE: &str = "relay-runtime-grafana";
const ACCOUNT_PREFIX: &str = "service-account-token-";
const DASHBOARD_LIMIT: usize = 50;
const PANEL_LIMIT: usize = 200;
const PANEL_DEPTH_LIMIT: usize = 8;
const LEAF_HEALTH_URL: &str = "https://leaf.eresea.net/api/version/health";
const NEXUS_READINESS_URL: &str = "https://nexus.eresea.net/readyz";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrafanaCheck {
    pub version: Option<String>,
    pub checked_at: u64,
    pub dashboards: Vec<GrafanaDashboard>,
    pub dashboard_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrafanaDashboard {
    pub uid: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrafanaDashboardPanel {
    pub id: Option<i64>,
    pub title: String,
    pub kind: String,
    pub datasource_type: Option<String>,
    pub datasource_uid: Option<String>,
    pub target_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrafanaDashboardPanelInventory {
    pub panels: Vec<GrafanaDashboardPanel>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
struct GrafanaDashboardBody {
    dashboard: Option<GrafanaDashboardSpec>,
    spec: Option<GrafanaDashboardSpec>,
}

#[derive(Debug, Deserialize)]
struct GrafanaDashboardSpec {
    #[serde(default)]
    panels: Vec<GrafanaPanelSpec>,
}

#[derive(Debug, Deserialize)]
struct GrafanaPanelSpec {
    id: Option<i64>,
    #[serde(default)]
    title: String,
    #[serde(rename = "type", default)]
    kind: String,
    datasource: Option<Value>,
    #[serde(default)]
    targets: Vec<serde::de::IgnoredAny>,
    #[serde(default)]
    panels: Vec<GrafanaPanelSpec>,
}

#[derive(Debug, Deserialize)]
struct GrafanaHealth {
    version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GrafanaDashboardResponse {
    uid: Option<String>,
    title: String,
    url: String,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeafHealthObservation {
    pub checked_at: u64,
    pub server_time: Option<String>,
    pub status_code: u16,
    pub response_headers_ms: u64,
    pub healthy: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusReadinessObservation {
    pub checked_at: u64,
    pub status_code: u16,
    pub response_headers_ms: u64,
    pub ready: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeafHealthResponse {
    status: String,
    timestamp: String,
}

#[derive(Debug, Deserialize)]
struct NexusReadinessResponse {
    status: String,
}

struct GrafanaAccess {
    base_url: Url,
    client: reqwest::Client,
    token: Option<HeaderValue>,
}

fn grafana_access(grafana_url: &str) -> Result<GrafanaAccess> {
    let base_url = grafana_base_url(grafana_url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::GrafanaHttpClient)?;
    let token = match entry(grafana_url)?.get_password() {
        Ok(token) => {
            let header = format!("Bearer {token}");
            Some(HeaderValue::from_str(&header).map_err(|_| Error::GrafanaTokenInvalid)?)
        }
        Err(keyring::Error::NoEntry) => None,
        Err(error) => return Err(Error::TokenStore(error.to_string())),
    };

    Ok(GrafanaAccess {
        base_url,
        client,
        token,
    })
}

fn entry(grafana_url: &str) -> Result<keyring::Entry> {
    let base_url = grafana_base_url(grafana_url)?;
    let account = format!(
        "{ACCOUNT_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(base_url.as_str().as_bytes()))
    );
    keyring::Entry::new(SERVICE, &account).map_err(|error| Error::TokenStore(error.to_string()))
}

#[tauri::command]
pub fn runtime_grafana_token_configured(grafana_url: String) -> Result<bool> {
    match entry(&grafana_url)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(Error::TokenStore(error.to_string())),
    }
}

#[tauri::command]
pub fn runtime_grafana_set_token(token: String, grafana_url: String) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        return Err(Error::GrafanaTokenEmpty);
    }
    let header = format!("Bearer {token}");
    HeaderValue::from_str(&header).map_err(|_| Error::GrafanaTokenInvalid)?;

    entry(&grafana_url)?
        .set_password(token)
        .map_err(|error| Error::TokenStore(error.to_string()))
}

#[tauri::command]
pub fn runtime_grafana_clear_token(grafana_url: String) -> Result<()> {
    match entry(&grafana_url)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(Error::TokenStore(error.to_string())),
    }
}

#[tauri::command]
pub async fn runtime_grafana_check(grafana_url: String) -> Result<GrafanaCheck> {
    let access = grafana_access(&grafana_url)?;
    let health_url = access
        .base_url
        .join("api/health")
        .map_err(|_| Error::GrafanaUrlInvalid)?;
    let mut health_request = access.client.get(health_url);
    if let Some(token) = access.token.as_ref() {
        health_request = health_request.header(AUTHORIZATION, token.clone());
    }
    let response = health_request
        .send()
        .await
        .map_err(|_| Error::GrafanaHealthRequestFailed)?;
    if !response.status().is_success() {
        return Err(Error::GrafanaHealthStatus(response.status().as_u16()));
    }
    let version = response
        .json::<GrafanaHealth>()
        .await
        .ok()
        .and_then(|health| health.version);

    let dashboards_url = access
        .base_url
        .join("api/search")
        .map_err(|_| Error::GrafanaUrlInvalid)?;
    let mut dashboard_request = access
        .client
        .get(dashboards_url)
        .query(&[("type", "dash-db"), ("limit", "50")]);
    if let Some(token) = access.token.as_ref() {
        dashboard_request = dashboard_request.header(AUTHORIZATION, token.clone());
    }

    let (dashboards, dashboard_error) = match dashboard_request.send().await {
        Ok(response) if response.status().is_success() => {
            match response.json::<Vec<GrafanaDashboardResponse>>().await {
                Ok(items) => (
                    items
                        .into_iter()
                        .filter(|item| item.kind == "dash-db")
                        .filter_map(|item| {
                            let url = access.base_url.join(&item.url).ok()?;
                            if url.origin() != access.base_url.origin()
                                || url.username() != ""
                                || url.password().is_some()
                            {
                                return None;
                            }
                            Some(GrafanaDashboard {
                                uid: item.uid?,
                                title: item.title,
                                url: url.to_string(),
                            })
                        })
                        .take(DASHBOARD_LIMIT)
                        .collect(),
                    None,
                ),
                Err(_) => (
                    Vec::new(),
                    Some("Grafana returned an invalid dashboard list.".into()),
                ),
            }
        }
        Ok(response) if response.status().as_u16() == 401 => (
            Vec::new(),
            Some("Dashboard discovery needs a Grafana token with dashboard read access.".into()),
        ),
        Ok(response) if response.status().as_u16() == 403 => (
            Vec::new(),
            Some("The Grafana token cannot read dashboards.".into()),
        ),
        Ok(response) => (
            Vec::new(),
            Some(format!(
                "Dashboard discovery returned HTTP {}.",
                response.status().as_u16()
            )),
        ),
        Err(_) => (
            Vec::new(),
            Some("Could not reach Grafana dashboard search.".into()),
        ),
    };

    Ok(GrafanaCheck {
        version,
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        dashboards,
        dashboard_error,
    })
}

#[tauri::command]
pub async fn runtime_grafana_dashboard_panels(
    uid: String,
    grafana_url: String,
) -> Result<GrafanaDashboardPanelInventory> {
    if uid.is_empty()
        || uid.len() > 40
        || !uid
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(Error::GrafanaDashboardUidInvalid);
    }

    let access = grafana_access(&grafana_url)?;
    let dashboard_url = access
        .base_url
        .join(&format!(
            "apis/dashboard.grafana.app/v1/namespaces/default/dashboards/{uid}"
        ))
        .map_err(|_| Error::GrafanaUrlInvalid)?;
    let mut request = access.client.get(dashboard_url);
    if let Some(token) = access.token.as_ref() {
        request = request.header(AUTHORIZATION, token.clone());
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| Error::GrafanaDashboardRequestFailed)?;
    if matches!(response.status().as_u16(), 400 | 404 | 405) {
        let legacy_url = access
            .base_url
            .join(&format!("api/dashboards/uid/{uid}"))
            .map_err(|_| Error::GrafanaUrlInvalid)?;
        let mut legacy_request = access.client.get(legacy_url);
        if let Some(token) = access.token.as_ref() {
            legacy_request = legacy_request.header(AUTHORIZATION, token.clone());
        }
        response = legacy_request
            .send()
            .await
            .map_err(|_| Error::GrafanaDashboardRequestFailed)?;
    }
    if !response.status().is_success() {
        return Err(Error::GrafanaDashboardStatus(response.status().as_u16()));
    }
    let body = response
        .json::<GrafanaDashboardBody>()
        .await
        .map_err(|_| Error::GrafanaDashboardResponseInvalid)?;
    let dashboard = body
        .spec
        .or(body.dashboard)
        .ok_or(Error::GrafanaDashboardResponseInvalid)?;
    let mut panels = Vec::new();
    let truncated = collect_panels(&dashboard.panels, 0, &mut panels);
    Ok(GrafanaDashboardPanelInventory { panels, truncated })
}

fn collect_panels(
    specs: &[GrafanaPanelSpec],
    depth: usize,
    panels: &mut Vec<GrafanaDashboardPanel>,
) -> bool {
    if depth > PANEL_DEPTH_LIMIT {
        return !specs.is_empty();
    }
    for panel in specs {
        if panels.len() >= PANEL_LIMIT {
            return true;
        }
        if panel.kind != "row" {
            let (datasource_type, datasource_uid) = match panel.datasource.as_ref() {
                Some(Value::String(uid)) => (None, Some(uid.clone())),
                Some(Value::Object(source)) => (
                    source
                        .get("type")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    source.get("uid").and_then(Value::as_str).map(str::to_owned),
                ),
                _ => (None, None),
            };
            panels.push(GrafanaDashboardPanel {
                id: panel.id,
                title: panel.title.clone(),
                kind: panel.kind.clone(),
                datasource_type,
                datasource_uid,
                target_count: panel.targets.len(),
            });
        }
        if collect_panels(&panel.panels, depth + 1, panels) {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn runtime_leaf_health() -> Result<LeafHealthObservation> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::LeafHealthRequestFailed)?;
    let request_started = Instant::now();
    let response = client
        .get(LEAF_HEALTH_URL)
        .send()
        .await
        .map_err(|_| Error::LeafHealthRequestFailed)?;
    let response_headers_ms = request_started.elapsed().as_millis() as u64;
    let status_code = response.status().as_u16();
    let checked_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let body = if response.status().is_success() {
        Some(
            response
                .json::<LeafHealthResponse>()
                .await
                .map_err(|_| Error::LeafHealthResponseInvalid)?,
        )
    } else {
        None
    };
    let healthy = body
        .as_ref()
        .is_some_and(|body| body.status == "healthy" && (200..300).contains(&status_code));

    Ok(LeafHealthObservation {
        checked_at,
        server_time: body.map(|body| body.timestamp),
        status_code,
        response_headers_ms,
        healthy,
    })
}

#[tauri::command]
pub async fn runtime_nexus_readiness() -> Result<NexusReadinessObservation> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::NexusReadinessRequestFailed)?;
    let request_started = Instant::now();
    let response = client
        .get(NEXUS_READINESS_URL)
        .send()
        .await
        .map_err(|_| Error::NexusReadinessRequestFailed)?;
    let response_headers_ms = request_started.elapsed().as_millis() as u64;
    let status = response.status();
    let status_code = status.as_u16();
    let ready = if status.is_success() {
        let body = response
            .json::<NexusReadinessResponse>()
            .await
            .map_err(|_| Error::NexusReadinessResponseInvalid)?;
        match body.status.as_str() {
            "ready" => true,
            "not_ready" => false,
            _ => return Err(Error::NexusReadinessResponseInvalid),
        }
    } else {
        false
    };

    Ok(NexusReadinessObservation {
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        status_code,
        response_headers_ms,
        ready,
    })
}

fn grafana_base_url(value: &str) -> Result<Url> {
    if value.trim().is_empty() {
        return Err(Error::GrafanaUrlMissing);
    }
    let mut url = Url::parse(value.trim()).map_err(|_| Error::GrafanaUrlInvalid)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::GrafanaUrlInvalid);
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}
