//! Nexus account sign-in through the `nexus-client` SDK.
//!
//! There is one sign-in path: "Sign in with Nexus" opens the hosted page in
//! the system browser and the `relay://auth/callback` deep link completes it
//! in [`handle_callback`]. The SDK owns PKCE, the keychain session, refresh
//! and the realtime event stream; this module wires it to Tauri.

use std::sync::Mutex;

use nexus_client::{AuthState, Error as NexusError, EventsHandle, NexusClient, NexusConfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;
use url::Url;

use crate::error::{Error, Result};
use crate::github;

pub const DEFAULT_ISSUER: &str = "https://nexus.eresea.net/api/v1";
const ISSUER_ENV: &str = "RELAY_NEXUS_ISSUER";
const ISSUER_SETTING: &str = "nexus.issuer";
const CLIENT_ID: &str = "relay";
const REDIRECT_URI: &str = "relay://auth/callback";
const SCOPES: [&str; 4] = ["openid", "profile", "email", "connections"];
const KEYRING_SERVICE: &str = "relay-nexus-auth";
const KEYRING_ACCOUNT: &str = "oauth-session";

/// Holds the running event stream; dropping it stops the stream.
#[derive(Default)]
pub struct NexusEvents(Mutex<Option<EventsHandle>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusAuthStatus {
    pub connected: bool,
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl NexusAuthStatus {
    fn signed_out(error: Option<String>) -> Self {
        Self {
            connected: false,
            user_id: None,
            email: None,
            display_name: None,
            error,
        }
    }
}

/// The Nexus API base: `RELAY_NEXUS_ISSUER`, else the `nexus.issuer` key in
/// `settings.json`, else the production default. Read once at startup.
fn issuer(app: &AppHandle) -> String {
    std::env::var(ISSUER_ENV)
        .ok()
        .or_else(|| {
            app.store("settings.json")
                .ok()?
                .get(ISSUER_SETTING)?
                .as_str()
                .map(str::to_owned)
        })
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_ISSUER.to_owned())
}

/// Builds the client, registers it as managed state and follows its auth
/// state: every change is emitted to the UI, and the event stream runs
/// exactly while a session exists.
pub fn init(app: &AppHandle) -> Result<()> {
    let config = NexusConfig {
        issuer: issuer(app),
        client_id: CLIENT_ID.into(),
        redirect_uri: REDIRECT_URI.into(),
        scopes: SCOPES.map(String::from).to_vec(),
        keyring_service: KEYRING_SERVICE.into(),
        keyring_account: KEYRING_ACCOUNT.into(),
    };
    retire_legacy_session(&config);
    let client = NexusClient::with_keyring(config).map_err(nexus_error)?;
    app.manage(client.clone());
    app.manage(NexusEvents::default());

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut changes = client.watch();
        let mut signed_in = matches!(client.auth_state(), AuthState::SignedIn { .. });
        if signed_in {
            start_events(&app, &client);
        }
        while changes.changed().await.is_ok() {
            let now_signed_in = matches!(*changes.borrow(), AuthState::SignedIn { .. });
            if now_signed_in && !signed_in {
                start_events(&app, &client);
                // A connection Relay already stored in this account (another
                // installation, or before a sign-out) is picked up here.
                if let Err(error) = github::adopt_connection(&app).await {
                    log::warn!("could not load the GitHub connection from Nexus: {error}");
                }
            } else if !now_signed_in {
                app.state::<NexusEvents>().0.lock().unwrap().take();
            }
            signed_in = now_signed_in;
            let _ = app.emit("nexus://auth", status_of(&client).await);
        }
    });
    Ok(())
}

fn start_events(app: &AppHandle, client: &NexusClient) {
    let handle = github::events::start(app, client);
    *app.state::<NexusEvents>().0.lock().unwrap() = Some(handle);
}

/// Sessions written before the SDK carry no `connections` scope and Nexus
/// cannot widen a refresh token's scope, so they cannot be migrated: the
/// entry is revoked (best effort) and deleted, and the user signs in again.
/// The legacy shape is told apart by its `userId` field.
fn retire_legacy_session(config: &NexusConfig) {
    let Ok(entry) = keyring::Entry::new(&config.keyring_service, &config.keyring_account) else {
        return;
    };
    let Ok(raw) = entry.get_password() else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    if value.get("userId").is_none() {
        return;
    }
    let _ = entry.delete_credential();
    if let Some(refresh_token) = value.get("refreshToken").and_then(|v| v.as_str()) {
        let url = format!("{}/oauth/revoke", config.issuer.trim_end_matches('/'));
        let form = [
            ("token", refresh_token.to_owned()),
            ("client_id", config.client_id.clone()),
        ];
        tauri::async_runtime::spawn(async move {
            let _ = reqwest::Client::new().post(url).form(&form).send().await;
        });
    }
}

pub fn client(app: &AppHandle) -> Result<NexusClient> {
    app.try_state::<NexusClient>()
        .map(|client| client.inner().clone())
        .ok_or_else(|| Error::NexusAuth("Nexus sign-in is unavailable".into()))
}

/// The signed-in client, or [`Error::NexusSignedOut`].
pub fn signed_in_client(app: &AppHandle) -> Result<NexusClient> {
    let client = client(app)?;
    match client.auth_state() {
        AuthState::SignedIn { .. } => Ok(client),
        AuthState::SignedOut => Err(Error::NexusSignedOut),
    }
}

pub fn nexus_error(error: NexusError) -> Error {
    if error.is_signed_out() {
        Error::NexusSignedOut
    } else {
        Error::NexusAuth(error.to_string())
    }
}

async fn status_of(client: &NexusClient) -> NexusAuthStatus {
    let AuthState::SignedIn { user } = client.auth_state() else {
        return NexusAuthStatus::signed_out(None);
    };
    let user = match user {
        Some(user) => Some(user),
        None => client.user().await.ok().flatten(),
    };
    NexusAuthStatus {
        connected: true,
        user_id: user.as_ref().map(|user| user.sub.clone()),
        email: user.as_ref().and_then(|user| user.email.clone()),
        display_name: user.and_then(|user| user.name),
        error: None,
    }
}

pub async fn status(app: &AppHandle) -> Result<NexusAuthStatus> {
    match app.try_state::<NexusClient>() {
        Some(client) => Ok(status_of(&client).await),
        None => Ok(NexusAuthStatus::signed_out(None)),
    }
}

/// Opens the hosted sign-in page in the system browser.
pub fn start(app: &AppHandle) -> Result<()> {
    let opener = app.clone();
    client(app)?
        .sign_in(move |url| {
            opener
                .opener()
                .open_url(url, None::<&str>)
                .map_err(Into::into)
        })
        .map(|_| ())
        .map_err(nexus_error)
}

/// Ends this installation's session; `everywhere` ends every session of the
/// account. Local tokens are cleared even if Nexus cannot be reached.
pub async fn sign_out(app: &AppHandle, everywhere: bool) -> Result<()> {
    client(app)?.sign_out(everywhere).await.map_err(nexus_error)
}

/// Completes sign-in from a `relay://auth/callback` deep link. Other URLs
/// (and stale or foreign callbacks) are ignored.
pub async fn handle_callback(app: AppHandle, callback: Url) {
    if callback.scheme() != "relay" {
        return;
    }
    let Ok(client) = client(&app) else {
        return;
    };
    match client.handle_callback(callback.as_str()).await {
        Ok(()) => {}
        Err(
            NexusError::InvalidCallback | NexusError::NoPendingSignIn | NexusError::StateMismatch,
        ) => {}
        Err(error) => {
            log::warn!("Nexus sign-in failed: {error}");
            let message = match error {
                NexusError::Authorization { code, .. } if code == "access_denied" => {
                    "Sign-in was cancelled.".to_owned()
                }
                NexusError::SignInExpired => "Sign-in took too long. Try again.".to_owned(),
                other => other.to_string(),
            };
            let _ = app.emit("nexus://auth", NexusAuthStatus::signed_out(Some(message)));
        }
    }
}
