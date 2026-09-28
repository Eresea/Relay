use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::error::{Error, Result};
use crate::nexus_auth;

use super::{api, save_connected, LinearConnection, LinearState};

const AUTHORIZE_URL: &str = "https://linear.app/oauth/authorize";
const TOKEN_URL: &str = "https://api.linear.app/oauth/token";
const REDIRECT_URI: &str = "relay://linear/callback";
const CLIENT_ID: Option<&str> = option_env!("RELAY_LINEAR_CLIENT_ID");
const SCOPE: &str = "read,write";
const AUTH_TIMEOUT_SECS: u64 = 600;

pub fn configured() -> bool {
    CLIENT_ID.is_some_and(|value| !value.trim().is_empty())
}

#[derive(Clone)]
pub(super) struct PendingAuth {
    state: String,
    verifier: String,
    expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TokenBundle {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub codex_links: Vec<LinearCodexLink>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub codex_project_policy: Vec<LinearCodexProjectPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearCodexLink {
    pub issue_id: String,
    pub device_id: String,
    pub workspace_repo: String,
    pub workspace_name: String,
    pub thread_id: String,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearCodexProjectPolicy {
    pub project_id: String,
    pub allowed: bool,
    #[serde(default)]
    pub workspace_repo: Option<String>,
    pub updated_at: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthEvent {
    connected: bool,
    connection: Option<LinearConnection>,
    error: Option<String>,
}

pub async fn start(app: AppHandle) -> Result<()> {
    if nexus_auth::status()?.connected == false {
        return Err(Error::LinearApi(
            "sign in to Nexus before connecting Linear".into(),
        ));
    }
    let client_id = CLIENT_ID
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            Error::LinearApi("Linear OAuth is not configured for this Relay build".into())
        })?;
    let (verifier, challenge) = generate_pkce();
    let state = random_token(32);
    {
        let app_state = app.state::<LinearState>();
        let mut pending = app_state.pending.lock().unwrap();
        if pending.is_some() {
            return Err(Error::LinearApi(
                "Linear sign-in is already in progress".into(),
            ));
        }
        *pending = Some(PendingAuth {
            state: state.clone(),
            verifier,
            expires_at: now_seconds() + AUTH_TIMEOUT_SECS,
        });
    }

    let mut authorize = Url::parse(AUTHORIZE_URL)
        .map_err(|_| Error::LinearApi("invalid Linear authorization URL".into()))?;
    authorize
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", SCOPE)
        .append_pair("actor", "user")
        .append_pair("prompt", "consent")
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state);
    if let Err(error) = app.opener().open_url(authorize.as_str(), None::<&str>) {
        app.state::<LinearState>().pending.lock().unwrap().take();
        return Err(Error::LinearApi(error.to_string()));
    }
    Ok(())
}

pub async fn handle_callback(app: AppHandle, callback: Url) {
    if callback.scheme() != "relay"
        || callback.host_str() != Some("linear")
        || callback.path() != "/callback"
    {
        return;
    }
    let params = callback
        .query_pairs()
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    let outcome = async {
        let pending = app
            .state::<LinearState>()
            .pending
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| Error::LinearApi("Linear sign-in expired; try again".into()))?;
        if pending.expires_at < now_seconds() || params.get("state") != Some(&pending.state) {
            return Err(Error::LinearApi(
                "Linear sign-in state did not match; try again".into(),
            ));
        }
        if let Some(error) = params.get("error") {
            return Err(Error::LinearApi(format!(
                "Linear sign-in was not approved ({error})"
            )));
        }
        let code = params
            .get("code")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| Error::LinearApi("Linear returned no authorization code".into()))?;
        let client_id = CLIENT_ID
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                Error::LinearApi("Linear OAuth is not configured for this Relay build".into())
            })?;
        let response = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| Error::LinearApi(error.to_string()))?
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id),
                ("redirect_uri", REDIRECT_URI),
                ("code", code.as_str()),
                ("code_verifier", pending.verifier.as_str()),
            ])
            .send()
            .await
            .map_err(|_| Error::LinearApi("could not exchange the Linear sign-in code".into()))?
            .error_for_status()
            .map_err(|error| {
                Error::LinearApi(format!(
                    "Linear token exchange returned HTTP {}",
                    error.status().unwrap_or_default()
                ))
            })?
            .json::<TokenResponse>()
            .await
            .map_err(|_| Error::LinearApi("Linear returned an invalid token response".into()))?;
        if response.access_token.is_empty() || response.refresh_token.is_empty() {
            return Err(Error::LinearApi(
                "Linear returned incomplete credentials".into(),
            ));
        }
        let bundle = TokenBundle {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            expires_at: now_seconds().saturating_add(response.expires_in),
            codex_links: Vec::new(),
            codex_project_policy: Vec::new(),
        };
        let viewer = api::viewer(&bundle.access_token).await?;
        let mut connection = LinearConnection {
            organization_id: viewer.organization.id.clone(),
            organization_name: viewer.organization.name.clone(),
            url_key: viewer.organization.url_key.clone(),
            viewer_id: viewer.id.clone(),
            viewer_name: viewer.name.clone(),
            viewer_email: viewer.email.clone(),
            nexus_credential_id: None,
        };
        save_connected(&app, bundle.clone(), viewer.clone())?;
        let warning = match super::nexus_sync::persist(&app, &connection, &bundle).await {
            Ok(credential_id) => {
                super::cancel_pending_revoke(&app, &connection.organization_id)?;
                connection.nexus_credential_id = Some(credential_id);
                super::save_connection(&app, connection.clone())?;
                None
            }
            Err(error) => Some(format!(
                "Connected on this device; Nexus sync failed: {error}"
            )),
        };
        Ok::<_, Error>((connection, warning))
    }
    .await;

    let event = match outcome {
        Ok((connection, error)) => AuthEvent {
            connected: true,
            connection: Some(connection),
            error,
        },
        Err(error) => AuthEvent {
            connected: false,
            connection: None,
            error: Some(error.to_string()),
        },
    };
    let _ = app.emit("linear://auth", event);
}

pub(super) async fn refresh(bundle: TokenBundle) -> Result<TokenBundle> {
    let client_id = CLIENT_ID
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            Error::LinearApi("Linear OAuth is not configured for this Relay build".into())
        })?;
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| Error::LinearApi(error.to_string()))?
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", bundle.refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|_| Error::LinearApi("could not refresh the Linear connection".into()))?
        .error_for_status()
        .map_err(|error| {
            Error::LinearApi(format!(
                "Linear token refresh returned HTTP {}",
                error.status().unwrap_or_default()
            ))
        })?
        .json::<TokenResponse>()
        .await
        .map_err(|_| Error::LinearApi("Linear returned an invalid refresh response".into()))?;
    if response.access_token.is_empty() || response.refresh_token.is_empty() {
        return Err(Error::LinearApi(
            "Linear returned incomplete refreshed credentials".into(),
        ));
    }
    Ok(TokenBundle {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        expires_at: now_seconds().saturating_add(response.expires_in),
        codex_links: bundle.codex_links,
        codex_project_policy: bundle.codex_project_policy,
    })
}

pub(super) fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn generate_pkce() -> (String, String) {
    let verifier = random_token(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub(super) fn random_token(size: usize) -> String {
    let mut random = vec![0; size];
    rand::thread_rng().fill_bytes(&mut random);
    URL_SAFE_NO_PAD.encode(random)
}
