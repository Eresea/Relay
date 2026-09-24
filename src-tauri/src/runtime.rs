use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use url::Url;

use crate::error::{Error, Result};

const SERVICE: &str = "relay-runtime-grafana";
const ACCOUNT: &str = "service-account-token";
const SETTINGS_KEY: &str = "runtime.grafana";
const DASHBOARD_LIMIT: usize = 50;
const LEAF_HEALTH_URL: &str = "https://leaf.eresea.net/api/version/health";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrafanaSettings {
    grafana_url: String,
}

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
    pub server_time: String,
    pub status_code: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeafHealthResponse {
    status: String,
    timestamp: String,
}

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|error| Error::TokenStore(error.to_string()))
}

#[tauri::command]
pub fn runtime_grafana_token_configured() -> Result<bool> {
    match entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(Error::TokenStore(error.to_string())),
    }
}

#[tauri::command]
pub fn runtime_grafana_set_token(token: String) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        return Err(Error::GrafanaTokenEmpty);
    }
    let header = format!("Bearer {token}");
    HeaderValue::from_str(&header).map_err(|_| Error::GrafanaTokenInvalid)?;

    entry()?
        .set_password(token)
        .map_err(|error| Error::TokenStore(error.to_string()))
}

#[tauri::command]
pub fn runtime_grafana_clear_token() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(Error::TokenStore(error.to_string())),
    }
}

#[tauri::command]
pub async fn runtime_grafana_check(app: AppHandle) -> Result<GrafanaCheck> {
    let store = app
        .store("settings.json")
        .map_err(|_| Error::GrafanaSettingsUnavailable)?;
    let settings = store
        .get(SETTINGS_KEY)
        .and_then(|value| serde_json::from_value::<GrafanaSettings>(value).ok())
        .unwrap_or_default();
    let base_url = grafana_base_url(&settings.grafana_url)?;
    let health_url = base_url
        .join("api/health")
        .map_err(|_| Error::GrafanaUrlInvalid)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::GrafanaHttpClient)?;
    let token = match entry()?.get_password() {
        Ok(token) => {
            let header = format!("Bearer {token}");
            Some(HeaderValue::from_str(&header).map_err(|_| Error::GrafanaTokenInvalid)?)
        }
        Err(keyring::Error::NoEntry) => None,
        Err(error) => return Err(Error::TokenStore(error.to_string())),
    };

    let mut health_request = client.get(health_url);
    if let Some(token) = token.as_ref() {
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

    let dashboards_url = base_url
        .join("api/search")
        .map_err(|_| Error::GrafanaUrlInvalid)?;
    let mut dashboard_request = client
        .get(dashboards_url)
        .query(&[("type", "dash-db"), ("limit", "50")]);
    if let Some(token) = token.as_ref() {
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
                            let url = base_url.join(&item.url).ok()?;
                            if url.origin() != base_url.origin()
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
pub async fn runtime_leaf_health() -> Result<LeafHealthObservation> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::LeafHealthRequestFailed)?;
    let response = client
        .get(LEAF_HEALTH_URL)
        .send()
        .await
        .map_err(|_| Error::LeafHealthRequestFailed)?;
    let status_code = response.status().as_u16();
    if !response.status().is_success() {
        return Err(Error::LeafHealthStatus(status_code));
    }

    let body = response
        .json::<LeafHealthResponse>()
        .await
        .map_err(|_| Error::LeafHealthResponseInvalid)?;
    if body.status != "healthy" {
        return Err(Error::LeafHealthResponseInvalid);
    }

    Ok(LeafHealthObservation {
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        server_time: body.timestamp,
        status_code,
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
