use std::sync::Mutex;
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

const NEXUS: &str = "https://nexus.eresea.net";
const CLIENT_ID: &str = "relay";
const REDIRECT_URI: &str = "relay://auth/callback";
const SCOPE: &str = "openid profile email credentials:create";
const KEYRING_SERVICE: &str = "relay-nexus-auth";
const KEYRING_ACCOUNT: &str = "oauth-session";

#[derive(Default)]
pub struct NexusAuthState {
    pending: Mutex<Option<PendingAuth>>,
    pending_mfa: Mutex<Option<PendingMfa>>,
    refresh: tokio::sync::Mutex<()>,
}

struct PendingAuth {
    state: String,
    verifier: String,
    expires_at: u64,
}

enum PendingMfa {
    Ticket(String),
    GoogleTransaction(String),
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
    pub mfa_required: bool,
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiAuthResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    mfa_required: bool,
    #[serde(default)]
    mfa_ticket: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub mfa_required: bool,
}

pub async fn login(app: &AppHandle, email: String, password: String) -> Result<LoginResult> {
    let http = http_client()?;
    let response: ApiAuthResponse = http
        .post(format!("{NEXUS}/api/v1/auth/login"))
        .json(&serde_json::json!({ "email": email, "password": password, "clientId": CLIENT_ID }))
        .send()
        .await
        .map_err(auth_request_error)?
        .error_for_status()
        .map_err(auth_request_error)?
        .json()
        .await
        .map_err(auth_request_error)?;
    if response.mfa_required {
        if response.mfa_ticket.is_empty() {
            return Err(Error::NexusAuth(
                "Nexus returned an invalid MFA challenge".into(),
            ));
        }
        *app.state::<NexusAuthState>().pending_mfa.lock().unwrap() =
            Some(PendingMfa::Ticket(response.mfa_ticket));
        return Ok(LoginResult { mfa_required: true });
    }
    let session = save_api_session(&http, response, "Nexus sign-in").await?;
    emit_connected(app, &session);
    Ok(LoginResult {
        mfa_required: false,
    })
}

pub async fn register(email: String, password: String, display_name: String) -> Result<()> {
    http_client()?
        .post(format!("{NEXUS}/api/v1/auth/register"))
        .json(&serde_json::json!({
            "email": email,
            "password": password,
            "displayName": display_name
        }))
        .send()
        .await
        .map_err(auth_request_error)?
        .error_for_status()
        .map_err(auth_request_error)?;
    Ok(())
}

pub async fn verify_email(token: String) -> Result<()> {
    http_client()?
        .post(format!("{NEXUS}/api/v1/auth/verify-email"))
        .json(&serde_json::json!({ "token": token }))
        .send()
        .await
        .map_err(auth_request_error)?
        .error_for_status()
        .map_err(auth_request_error)?;
    Ok(())
}

pub async fn verify_mfa(app: &AppHandle, code: String, recovery_code: String) -> Result<()> {
    let challenge = app
        .state::<NexusAuthState>()
        .pending_mfa
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| Error::NexusAuth("sign-in challenge expired; try again".into()))?;
    let http = http_client()?;
    let (endpoint, payload) = match challenge {
        PendingMfa::Ticket(ticket) => (
            Url::parse(&format!("{NEXUS}/api/v1/auth/mfa/verify"))
                .map_err(|_| Error::NexusAuth("invalid MFA verification URL".into()))?,
            serde_json::json!({
                "ticket": ticket,
                "code": code,
                "recoveryCode": recovery_code,
                "clientId": CLIENT_ID
            }),
        ),
        PendingMfa::GoogleTransaction(transaction_id) => {
            let mut endpoint = Url::parse(&format!("{NEXUS}/api/v1/auth/transactions/"))
                .map_err(|_| Error::NexusAuth("invalid MFA verification URL".into()))?;
            endpoint
                .path_segments_mut()
                .map_err(|_| Error::NexusAuth("invalid MFA verification URL".into()))?
                .push(&transaction_id)
                .push("mfa")
                .push("verify");
            (
                endpoint,
                serde_json::json!({ "code": code, "recoveryCode": recovery_code }),
            )
        }
    };
    let response: ApiAuthResponse = http
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(auth_request_error)?
        .error_for_status()
        .map_err(auth_request_error)?
        .json()
        .await
        .map_err(auth_request_error)?;
    let session = save_api_session(&http, response, "Nexus MFA sign-in").await?;
    emit_connected(app, &session);
    Ok(())
}

pub fn google_start(app: &AppHandle) -> Result<()> {
    let mut authorize = Url::parse(&format!("{NEXUS}/api/v1/auth/oauth/google/start"))
        .map_err(|_| Error::NexusAuth("invalid Google authorization URL".into()))?;
    authorize
        .query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("platform", "desktop")
        .append_pair("handoff", "auto");
    app.opener()
        .open_url(authorize.as_str(), None::<&str>)
        .map_err(|error| Error::NexusAuth(error.to_string()))
}

async fn save_api_session(
    http: &reqwest::Client,
    response: ApiAuthResponse,
    flow: &str,
) -> Result<Session> {
    if response.access_token.is_empty() {
        return Err(Error::NexusAuth(
            "Nexus returned an invalid sign-in response".into(),
        ));
    }
    let (verifier, challenge) = generate_pkce();
    let state = random_url_token(32);
    let bootstrap_token = response.access_token;
    let response = http
        .get(format!("{NEXUS}/api/v1/oauth/authorize"))
        .query(&[
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", REDIRECT_URI),
            ("scope", SCOPE),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
        ])
        .bearer_auth(&bootstrap_token)
        .send()
        .await
        .map_err(|error| auth_request_error_at(&format!("{flow} authorization"), error))?;
    if response.status() != reqwest::StatusCode::FOUND {
        return Err(Error::NexusAuth(format!(
            "{flow} authorization returned {}",
            response.status()
        )));
    }
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| Error::NexusAuth("Nexus returned no authorization code".into()))?;
    let callback = Url::parse(location)
        .map_err(|_| Error::NexusAuth("Nexus returned an invalid authorization redirect".into()))?;
    let params = callback
        .query_pairs()
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    if callback.scheme() != "relay"
        || callback.host_str() != Some("auth")
        || callback.path() != "/callback"
        || params.get("state") != Some(&state)
    {
        return Err(Error::NexusAuth(
            "Nexus returned an invalid authorization response".into(),
        ));
    }
    let code = params
        .get("code")
        .filter(|code| !code.is_empty())
        .ok_or_else(|| Error::NexusAuth("Nexus returned no authorization code".into()))?;
    let token: TokenResponse = http
        .post(format!("{NEXUS}/api/v1/oauth/token"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", REDIRECT_URI),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|error| auth_request_error_at(&format!("{flow} token exchange"), error))?
        .error_for_status()
        .map_err(|error| auth_request_error_at(&format!("{flow} token exchange"), error))?
        .json()
        .await
        .map_err(auth_request_error)?;
    let _ = http
        .post(format!("{NEXUS}/api/v1/auth/logout"))
        .bearer_auth(bootstrap_token)
        .send()
        .await;
    let user: UserInfo = http
        .get(format!("{NEXUS}/api/v1/oauth/userinfo"))
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|error| auth_request_error_at(&format!("{flow} profile lookup"), error))?
        .error_for_status()
        .map_err(|error| auth_request_error_at(&format!("{flow} profile lookup"), error))?
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
    Ok(session)
}

fn generate_pkce() -> (String, String) {
    let mut random = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut random);
    let verifier = URL_SAFE_NO_PAD.encode(random);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn random_url_token(size: usize) -> String {
    let mut random = vec![0u8; size];
    rand::thread_rng().fill_bytes(&mut random);
    URL_SAFE_NO_PAD.encode(random)
}

fn emit_connected(app: &AppHandle, session: &Session) {
    let _ = app.emit(
        "nexus://auth",
        NexusAuthStatus {
            connected: true,
            mfa_required: false,
            user_id: Some(session.user_id.clone()),
            email: Some(session.email.clone()),
            display_name: Some(session.display_name.clone()),
            error: None,
        },
    );
}

fn emit_disconnected(app: &AppHandle, error: Option<String>) {
    let _ = app.emit(
        "nexus://auth",
        NexusAuthStatus {
            connected: false,
            mfa_required: false,
            user_id: None,
            email: None,
            display_name: None,
            error,
        },
    );
}

pub fn status() -> Result<NexusAuthStatus> {
    let Some(session) = load_session()? else {
        return Ok(NexusAuthStatus {
            connected: false,
            mfa_required: false,
            user_id: None,
            email: None,
            display_name: None,
            error: None,
        });
    };
    Ok(NexusAuthStatus {
        connected: true,
        mfa_required: false,
        user_id: Some(session.user_id),
        email: Some(session.email),
        display_name: Some(session.display_name),
        error: None,
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
    if let Err(error) = app.opener().open_url(authorize.as_str(), None::<&str>) {
        app.state::<NexusAuthState>().pending.lock().unwrap().take();
        return Err(Error::NexusAuth(error.to_string()));
    }
    Ok(())
}

pub fn logout(app: &AppHandle) -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(Error::TokenStore(error.to_string())),
    }?;
    emit_disconnected(app, None);
    Ok(())
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
    if let Some(transaction_id) = params.get("mfaTransactionId") {
        *app.state::<NexusAuthState>().pending_mfa.lock().unwrap() =
            Some(PendingMfa::GoogleTransaction(transaction_id.clone()));
        let _ = app.emit(
            "nexus://auth",
            NexusAuthStatus {
                connected: false,
                mfa_required: true,
                user_id: None,
                email: None,
                display_name: None,
                error: None,
            },
        );
        return;
    }
    if let Some(transaction_id) = params.get("authTransactionId") {
        match exchange_google_transaction(transaction_id).await {
            Ok(session) => emit_connected(&app, &session),
            Err(error) => {
                log::warn!("Nexus Google sign-in failed: {error}");
                emit_disconnected(&app, Some(error.to_string()));
            }
        }
        return;
    }
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
                    mfa_required: false,
                user_id: Some(session.user_id),
                email: Some(session.email),
                display_name: Some(session.display_name),
                error: None,
                },
            );
        }
        Err(error) => {
            log::warn!("Nexus sign-in failed: {error}");
            let _ = app.emit(
                "nexus://auth",
                NexusAuthStatus {
                    connected: false,
                    mfa_required: false,
                    user_id: None,
                    email: None,
                    display_name: None,
                    error: None,
                },
            );
        }
    }
}

async fn exchange_google_transaction(transaction_id: &str) -> Result<Session> {
    let http = http_client()?;
    let response: ApiAuthResponse = http
        .post(format!(
            "{NEXUS}/api/v1/auth/transactions/{transaction_id}/exchange"
        ))
        .send()
        .await
        .map_err(|error| auth_request_error_at("Google transaction exchange", error))?
        .error_for_status()
        .map_err(|error| auth_request_error_at("Google transaction exchange", error))?
        .json()
        .await
        .map_err(|error| auth_request_error_at("Google transaction response", error))?;
    if response.access_token.is_empty() {
        return Err(Error::NexusAuth(
            "Google transaction exchange returned no access token".into(),
        ));
    }
    save_api_session(&http, response, "Google sign-in").await
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

fn auth_request_error_at(stage: &str, error: reqwest::Error) -> Error {
    Error::NexusAuth(format!(
        "{stage} failed with {}",
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
