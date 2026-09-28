use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::error::{Error, Result};
use crate::nexus_auth;

use super::{LinearConnection, LinearState, api, save_connected};

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
    agent_organization_id: Option<String>,
}

fn take_callback_pending(
    pending: &mut Option<PendingAuth>,
    state: &str,
    now: u64,
) -> Option<PendingAuth> {
    let attempt = pending.as_ref()?;
    if attempt.expires_at < now {
        pending.take();
        return None;
    }
    if attempt.state != state {
        return None;
    }
    pending.take()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TokenBundle {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentTokenBundle>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub codex_links: Vec<LinearCodexLink>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub codex_project_policy: Vec<LinearCodexProjectPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentTokenBundle {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
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
    start_with_actor(app, None).await
}

pub async fn start_agent(app: AppHandle, organization_id: String) -> Result<()> {
    if !super::connections(&app)?
        .iter()
        .any(|connection| connection.organization_id == organization_id)
    {
        return Err(Error::LinearApi(
            "Connect this Linear workspace first".into(),
        ));
    }
    start_with_actor(app, Some(organization_id)).await
}

async fn start_with_actor(app: AppHandle, agent_organization_id: Option<String>) -> Result<()> {
    if !nexus_auth::status()?.connected {
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
        if pending
            .as_ref()
            .is_some_and(|attempt| attempt.expires_at >= now_seconds())
        {
            return Err(Error::LinearApi(
                "Linear sign-in is already in progress".into(),
            ));
        }
        *pending = Some(PendingAuth {
            state: state.clone(),
            verifier,
            expires_at: now_seconds() + AUTH_TIMEOUT_SECS,
            agent_organization_id: agent_organization_id.clone(),
        });
    }

    let authorize = authorization_url(
        client_id,
        &challenge,
        &state,
        agent_organization_id.is_some(),
    )?;
    if let Err(error) = app.opener().open_url(authorize.as_str(), None::<&str>) {
        app.state::<LinearState>().pending.lock().unwrap().take();
        return Err(Error::LinearApi(error.to_string()));
    }
    Ok(())
}

pub fn cancel(app: &AppHandle) {
    app.state::<LinearState>().pending.lock().unwrap().take();
}

fn authorization_url(client_id: &str, challenge: &str, state: &str, agent: bool) -> Result<Url> {
    let mut authorize = Url::parse(AUTHORIZE_URL)
        .map_err(|_| Error::LinearApi("invalid Linear authorization URL".into()))?;
    authorize
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", SCOPE)
        .append_pair("actor", if agent { "app" } else { "user" })
        .append_pair("prompt", "consent")
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    Ok(authorize)
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
        let Some(state) = params.get("state") else {
            return Ok::<_, Error>(None);
        };
        let pending = take_callback_pending(
            &mut app.state::<LinearState>().pending.lock().unwrap(),
            state,
            now_seconds(),
        );
        let Some(pending) = pending else {
            return Ok(None);
        };
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
        let viewer = api::viewer(&response.access_token).await?;
        if let Some(organization_id) = pending.agent_organization_id {
            if viewer.organization.id != organization_id {
                return Err(Error::LinearApi(
                    "Relay agent was installed into a different Linear workspace".into(),
                ));
            }
            let mut connection = super::connections(&app)?
                .into_iter()
                .find(|connection| connection.organization_id == organization_id)
                .ok_or_else(|| Error::LinearApi("Connect this Linear workspace first".into()))?;
            let mut bundle = super::stored_bundle(&organization_id)?;
            bundle.agent = Some(AgentTokenBundle {
                access_token: response.access_token,
                refresh_token: response.refresh_token,
                expires_at: now_seconds().saturating_add(response.expires_in),
            });
            super::save_bundle(&organization_id, &bundle)?;
            connection.agent_installed = true;
            let warning = match super::nexus_sync::persist(&app, &connection, &bundle).await {
                Ok(credential_id) => {
                    super::cancel_pending_revoke(&app, &organization_id)?;
                    connection.nexus_credential_id = Some(credential_id);
                    connection.nexus_sync_pending = false;
                    None
                }
                Err(error) => {
                    connection.nexus_sync_pending = true;
                    Some(format!(
                        "Relay agent installed on this device; Nexus sync failed: {error}"
                    ))
                }
            };
            super::save_connection(&app, connection.clone())?;
            return Ok::<_, Error>(Some((connection, warning)));
        }
        let bundle = TokenBundle {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            expires_at: now_seconds().saturating_add(response.expires_in),
            agent: None,
            codex_links: Vec::new(),
            codex_project_policy: Vec::new(),
        };
        let mut connection = LinearConnection {
            organization_id: viewer.organization.id.clone(),
            organization_name: viewer.organization.name.clone(),
            url_key: viewer.organization.url_key.clone(),
            viewer_id: viewer.id.clone(),
            viewer_name: viewer.name.clone(),
            viewer_email: viewer.email.clone(),
            nexus_credential_id: None,
            agent_installed: false,
            paused_on_device: false,
            nexus_sync_pending: false,
        };
        save_connected(&app, bundle.clone(), viewer.clone())?;
        let warning = match super::nexus_sync::persist(&app, &connection, &bundle).await {
            Ok(credential_id) => {
                super::cancel_pending_revoke(&app, &connection.organization_id)?;
                connection.nexus_credential_id = Some(credential_id);
                connection.nexus_sync_pending = false;
                None
            }
            Err(error) => {
                connection.nexus_sync_pending = true;
                Some(format!(
                    "Connected on this device; Nexus sync failed: {error}"
                ))
            }
        };
        super::save_connection(&app, connection.clone())?;
        Ok::<_, Error>(Some((connection, warning)))
    }
    .await;

    let event = match outcome {
        Ok(Some((connection, error))) => AuthEvent {
            connected: true,
            connection: Some(connection),
            error,
        },
        Ok(None) => return,
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
        agent: bundle.agent,
        codex_links: bundle.codex_links,
        codex_project_policy: bundle.codex_project_policy,
    })
}

pub(super) async fn refresh_agent(bundle: AgentTokenBundle) -> Result<AgentTokenBundle> {
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
        .map_err(|_| Error::LinearApi("could not refresh the Relay Linear agent".into()))?
        .error_for_status()
        .map_err(|error| {
            Error::LinearApi(format!(
                "Linear agent token refresh returned HTTP {}",
                error.status().unwrap_or_default()
            ))
        })?
        .json::<TokenResponse>()
        .await
        .map_err(|_| {
            Error::LinearApi("Linear returned an invalid agent refresh response".into())
        })?;
    if response.access_token.is_empty() || response.refresh_token.is_empty() {
        return Err(Error::LinearApi(
            "Linear returned incomplete agent credentials".into(),
        ));
    }
    Ok(AgentTokenBundle {
        access_token: response.access_token,
        refresh_token: response.refresh_token,
        expires_at: now_seconds().saturating_add(response.expires_in),
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

#[cfg(test)]
mod tests {
    use super::{authorization_url, take_callback_pending, PendingAuth};

    #[test]
    fn stale_callbacks_do_not_consume_a_new_sign_in_attempt() {
        let current = PendingAuth {
            state: "current".into(),
            verifier: "verifier".into(),
            expires_at: 20,
            agent_organization_id: None,
        };
        let mut pending = Some(current);

        assert!(take_callback_pending(&mut pending, "stale", 10).is_none());
        assert_eq!(
            pending.as_ref().map(|attempt| attempt.state.as_str()),
            Some("current")
        );
    }

    #[test]
    fn expired_sign_in_attempts_are_cleared_by_callback() {
        let mut pending = Some(PendingAuth {
            state: "expired".into(),
            verifier: "verifier".into(),
            expires_at: 10,
            agent_organization_id: None,
        });

        assert!(take_callback_pending(&mut pending, "expired", 11).is_none());
        assert!(pending.is_none());
    }

    #[test]
    fn authorize_flow_keeps_user_and_agent_actors_separate() {
        let user = authorization_url("client", "challenge", "state", false).unwrap();
        let agent = authorization_url("client", "challenge", "state", true).unwrap();
        let user_actor = user
            .query_pairs()
            .find(|(key, _)| key == "actor")
            .unwrap()
            .1;
        let agent_actor = agent
            .query_pairs()
            .find(|(key, _)| key == "actor")
            .unwrap()
            .1;
        assert_eq!(user_actor, "user");
        assert_eq!(agent_actor, "app");
        assert!(
            agent
                .query_pairs()
                .any(|(key, value)| { key == "code_challenge_method" && value == "S256" })
        );
    }
}
