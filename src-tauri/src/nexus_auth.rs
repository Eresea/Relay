use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use crate::error::{Error, Result};

const NEXUS: &str = "https://nexus.eresea.net";
const CLIENT_ID: &str = "relay";
const REDIRECT_URI: &str = "relay://auth/callback";
const SCOPE: &str = "openid profile email credentials:create";
const KEYRING_SERVICE: &str = "relay-nexus-auth";
const KEYRING_ACCOUNT: &str = "oauth-session";

#[derive(Default)]
pub struct NexusAuthState {
    pending: Mutex<Option<PendingAuth>>,
    refresh: tokio::sync::Mutex<()>,
}

struct PendingAuth {
    state: String,
    verifier: String,
    expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    user_id: String,
    email: String,
    display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusAuthStatus {
    pub connected: bool,
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
}

#[derive(Deserialize)]
struct UserInfo {
    sub: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    name: String,
}

pub fn status() -> Result<NexusAuthStatus> {
    let Some(session) = load_session()? else {
        return Ok(NexusAuthStatus {
            connected: false,
            user_id: None,
            email: None,
            display_name: None,
        });
    };
    Ok(NexusAuthStatus {
        connected: true,
        user_id: Some(session.user_id),
        email: Some(session.email),
        display_name: Some(session.display_name),
    })
}

pub fn start(app: &AppHandle) -> Result<()> {
    let mut random = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut random);
    let verifier = URL_SAFE_NO_PAD.encode(random);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut random_state = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut random_state);
    let state = URL_SAFE_NO_PAD.encode(random_state);
    {
        let auth_state = app.state::<NexusAuthState>();
        let mut pending = auth_state.pending.lock().unwrap();
        if pending.is_some() {
            return Err(Error::NexusAuth("sign-in is already in progress".into()));
        }
        *pending = Some(PendingAuth {
            state: state.clone(),
            verifier,
            expires_at: now_seconds() + 600,
        });
    }

    let mut authorize = Url::parse(&format!("{NEXUS}/api/v1/oauth/authorize"))
        .map_err(|_| Error::NexusAuth("invalid authorization URL".into()))?;
    authorize
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state);
    if let Err(error) = tauri_plugin_opener::open_url(authorize.as_str(), None::<&str>) {
        app.state::<NexusAuthState>().pending.lock().unwrap().take();
        return Err(Error::NexusAuth(error.to_string()));
    }
    Ok(())
}

pub fn logout() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(Error::TokenStore(error.to_string())),
    }
}

pub async fn handle_callback(app: AppHandle, callback: Url) {
    if callback.scheme() != "relay"
        || callback.host_str() != Some("auth")
        || callback.path() != "/callback"
    {
        return;
    }
    let params = callback
        .query_pairs()
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    let state = params.get("state").cloned().unwrap_or_default();
    let pending = {
        let auth_state = app.state::<NexusAuthState>();
        let mut slot = auth_state.pending.lock().unwrap();
        if slot
            .as_ref()
            .is_none_or(|pending| pending.state != state || pending.expires_at <= now_seconds())
        {
            return;
        }
        slot.take().unwrap()
    };
    let result = async {
        if params.contains_key("error") {
            return Err(Error::NexusAuth("sign-in was declined".into()));
        }
        let code = params
            .get("code")
            .filter(|code| !code.is_empty())
            .ok_or_else(|| Error::NexusAuth("missing authorization code".into()))?;
        let http = http_client()?;
        let token: TokenResponse = http
            .post(format!("{NEXUS}/api/v1/oauth/token"))
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", CLIENT_ID),
                ("redirect_uri", REDIRECT_URI),
                ("code", code.as_str()),
                ("code_verifier", pending.verifier.as_str()),
            ])
            .send()
            .await
            .map_err(auth_request_error)?
            .error_for_status()
            .map_err(auth_request_error)?
            .json()
            .await
            .map_err(auth_request_error)?;
        let user: UserInfo = http
            .get(format!("{NEXUS}/api/v1/oauth/userinfo"))
            .bearer_auth(&token.access_token)
            .send()
            .await
            .map_err(auth_request_error)?
            .error_for_status()
            .map_err(auth_request_error)?
            .json()
            .await
            .map_err(auth_request_error)?;
        let session = Session {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: now_seconds().saturating_add(token.expires_in),
            user_id: user.sub,
            email: user.email,
            display_name: user.name,
        };
        save_session(&session)?;
        Ok::<_, Error>(session)
    }
    .await;

    match result {
        Ok(session) => {
            let _ = app.emit(
                "nexus://auth",
                NexusAuthStatus {
                    connected: true,
                    user_id: Some(session.user_id),
                    email: Some(session.email),
                    display_name: Some(session.display_name),
                },
            );
        }
        Err(error) => {
            log::warn!("Nexus sign-in failed: {error}");
            let _ = app.emit(
                "nexus://auth",
                NexusAuthStatus {
                    connected: false,
                    user_id: None,
                    email: None,
                    display_name: None,
                },
            );
        }
    }
}

pub async fn access_token(app: &AppHandle) -> Result<String> {
    let state = app.state::<NexusAuthState>();
    let _guard = state.refresh.lock().await;
    let session =
        load_session()?.ok_or_else(|| Error::NexusAuth("sign in to Nexus first".into()))?;
    if session.expires_at > now_seconds() + 30 {
        return Ok(session.access_token);
    }
    let http = http_client()?;
    let token: TokenResponse = http
        .post(format!("{NEXUS}/api/v1/oauth/token"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", session.refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(auth_request_error)?
        .error_for_status()
        .map_err(auth_request_error)?
        .json()
        .await
        .map_err(auth_request_error)?;
    let refreshed = Session {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: now_seconds().saturating_add(token.expires_in),
        ..session
    };
    save_session(&refreshed)?;
    Ok(refreshed.access_token)
}

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| Error::NexusAuth(error.to_string()))
}

fn auth_request_error(error: reqwest::Error) -> Error {
    Error::NexusAuth(format!(
        "request failed with {}",
        error
            .status()
            .map_or("network error".into(), |status| status.to_string())
    ))
}

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| Error::TokenStore(error.to_string()))
}

fn load_session() -> Result<Option<Session>> {
    match entry()?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|error| Error::NexusAuth(error.to_string())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(Error::TokenStore(error.to_string())),
    }
}

fn save_session(session: &Session) -> Result<()> {
    let value =
        serde_json::to_string(session).map_err(|error| Error::NexusAuth(error.to_string()))?;
    entry()?
        .set_password(&value)
        .map_err(|error| Error::TokenStore(error.to_string()))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
