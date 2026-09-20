//! The Gmail connector: OAuth sign-in, encrypted-at-rest token storage, and a
//! polling job that turns new important mail into `AppEvent::Notification`s.
//!
//! Three things this deliberately is not:
//!
//! - **Not push-based.** Gmail's push notifications need a Google Cloud
//!   Pub/Sub subscription and a publicly reachable HTTPS endpoint, neither of
//!   which a local desktop app has. Polling on an interval through the
//!   existing `jobs` pipeline is the only option available here.
//! - **Not a full mailbox reader.** The connector only ever asks for message
//!   headers and Gmail labels (`gmail.metadata` scope — see `api::SCOPE`),
//!   never a body or attachment, and only ever shows sender + subject in a
//!   notification.
//! - **Not gated behind a master password.** Unlike the password vault, this
//!   has to keep working with no window open and nobody around to unlock it.
//!   See `secret.rs` for how the refresh token is still encrypted at rest
//!   without one.
//!
//! Google issues a client id (and, for a "Desktop app" OAuth client, a
//! client secret it does not expect to stay confidential — see `oauth.rs`)
//! per Google Cloud project. Relay's own pair is compiled in from
//! `gmail.config.toml`, committed the same way any other installed
//! application ships its client id — see that file for why that is safe for
//! this OAuth flow. `RELAY_GMAIL_CLIENT_ID` / `RELAY_GMAIL_CLIENT_SECRET`
//! override it when set, e.g. to develop against a different Google Cloud
//! project without editing the tracked file.

mod api;
mod oauth;
mod poll;
mod rules;
mod secret;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

pub use api::{GoogleApi, HttpGoogleApi};
pub use rules::NotificationRules;
pub use secret::{KeyStore, OsKeyStore};

use crate::error::{Error, Result};
use crate::events::{EventSink, NotificationStatus};
use crate::jobs::{self, JobId, JobRegistry};
use api::{ExchangeCodeParams, RefreshParams};
use poll::PollCheckpoint;
use secret::EncryptedSecret;

const GMAIL_FILE: &str = "gmail.json";
pub const DEFAULT_POLL_INTERVAL_SECS: u64 = 60;
/// A poll costs one `history.list` call (2 quota units) plus one
/// `messages.get` per genuinely new message (5 units); Gmail's default quota
/// is 250 units/second/user, so even a busy inbox polled this often stays
/// far under it. This is also a floor on `set_settings`, not just a default.
const MIN_POLL_INTERVAL_SECS: u64 = 30;
const AUTH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CLIENT_ID_VAR: &str = "RELAY_GMAIL_CLIENT_ID";
const CLIENT_SECRET_VAR: &str = "RELAY_GMAIL_CLIENT_SECRET";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailStatus {
    pub connected: bool,
    pub connecting: bool,
    pub account_email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailSettings {
    pub rules: NotificationRules,
    pub poll_interval_secs: u64,
}

#[derive(Debug, Clone)]
struct Config {
    account_email: Option<String>,
    last_history_id: Option<String>,
    poll_interval_secs: u64,
    rules: NotificationRules,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            account_email: None,
            last_history_id: None,
            poll_interval_secs: DEFAULT_POLL_INTERVAL_SECS,
            rules: NotificationRules::default(),
        }
    }
}

struct ConnectedSession {
    // Best-effort only, matching vault.rs's `Unlocked`: Rust cannot guarantee
    // a `String`'s heap allocation is wiped, so this is not a hard secrecy
    // guarantee, just an in-memory-only lifetime for as long as connected.
    refresh_token: String,
    access_token: Option<String>,
    access_token_expires_at: Option<SystemTime>,
    poll_job_id: Option<JobId>,
}

#[derive(Default)]
enum Session {
    #[default]
    Disconnected,
    Connecting {
        cancel: oneshot::Sender<()>,
    },
    Connected(ConnectedSession),
}

#[derive(Default)]
struct Runtime {
    config: Config,
    session: Session,
}

#[derive(Default)]
pub struct GmailState(Mutex<Runtime>);

/// `gmail.config.toml`, compiled in at build time — not read from disk at
/// runtime, since a packaged Tauri bundle would not otherwise carry it.
const COMPILED_CONFIG_TOML: &str = include_str!("../../gmail.config.toml");

#[derive(Debug, Clone, Default, Deserialize)]
struct CompiledConfig {
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
}

fn compiled_credentials() -> CompiledConfig {
    toml::from_str(COMPILED_CONFIG_TOML).unwrap_or_else(|error| {
        log::warn!("gmail.config.toml failed to parse: {error}");
        CompiledConfig::default()
    })
}

/// Env vars win when set (development against a different Google Cloud
/// project); otherwise falls back to the compiled-in default, and only
/// errors if neither supplies a client id.
fn resolve_credentials(
    env_client_id: Option<String>,
    env_client_secret: Option<String>,
    compiled: CompiledConfig,
) -> Result<(String, Option<String>)> {
    if let Some(client_id) = env_client_id {
        return Ok((client_id, env_client_secret));
    }
    if compiled.client_id.is_empty() {
        return Err(Error::GmailClientNotConfigured);
    }
    let client_secret = (!compiled.client_secret.is_empty()).then_some(compiled.client_secret);
    Ok((compiled.client_id, client_secret))
}

fn client_credentials() -> Result<(String, Option<String>)> {
    resolve_credentials(
        std::env::var(CLIENT_ID_VAR).ok(),
        std::env::var(CLIENT_SECRET_VAR).ok(),
        compiled_credentials(),
    )
}

fn file_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(GMAIL_FILE))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GmailFile {
    version: u8,
    account_email: String,
    last_history_id: Option<String>,
    poll_interval_secs: u64,
    rules: NotificationRules,
    encrypted_refresh_token: EncryptedSecret,
}

fn read_file(app: &AppHandle) -> Result<Option<GmailFile>> {
    let path = file_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    Ok(Some(
        serde_json::from_str(&raw).map_err(|e| Error::GmailCorrupt(e.to_string()))?,
    ))
}

fn write_file(app: &AppHandle, file: &GmailFile) -> Result<()> {
    let path = file_path(app)?;
    let raw = serde_json::to_string_pretty(file).map_err(|e| Error::GmailCorrupt(e.to_string()))?;
    fs::write(path, raw)?;
    Ok(())
}

fn delete_file(app: &AppHandle) -> Result<()> {
    let path = file_path(app)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn persist(
    app: &AppHandle,
    config: &Config,
    encrypted_refresh_token: EncryptedSecret,
) -> Result<()> {
    let account_email = config
        .account_email
        .clone()
        .ok_or(Error::GmailNotConnected)?;
    write_file(
        app,
        &GmailFile {
            version: 1,
            account_email,
            last_history_id: config.last_history_id.clone(),
            poll_interval_secs: config.poll_interval_secs,
            rules: config.rules.clone(),
            encrypted_refresh_token,
        },
    )
}

pub fn status(state: &GmailState) -> GmailStatus {
    let runtime = state.0.lock().unwrap();
    match &runtime.session {
        Session::Disconnected => GmailStatus {
            connected: false,
            connecting: false,
            account_email: None,
        },
        Session::Connecting { .. } => GmailStatus {
            connected: false,
            connecting: true,
            account_email: None,
        },
        Session::Connected(_) => GmailStatus {
            connected: true,
            connecting: false,
            account_email: runtime.config.account_email.clone(),
        },
    }
}

pub fn get_settings(state: &GmailState) -> GmailSettings {
    let runtime = state.0.lock().unwrap();
    GmailSettings {
        rules: runtime.config.rules.clone(),
        poll_interval_secs: runtime.config.poll_interval_secs,
    }
}

pub fn set_settings(
    app: &AppHandle,
    state: &GmailState,
    mut settings: GmailSettings,
) -> Result<()> {
    settings.poll_interval_secs = settings.poll_interval_secs.max(MIN_POLL_INTERVAL_SECS);
    let mut runtime = state.0.lock().unwrap();
    runtime.config.rules = settings.rules;
    runtime.config.poll_interval_secs = settings.poll_interval_secs;

    // Rules and cadence take effect on the polling job's next iteration,
    // which rereads `GmailState` fresh every cycle rather than capturing a
    // snapshot at spawn time — so persisting here is enough, nothing needs
    // to be signalled to a running job.
    if let Session::Connected(session) = &runtime.session {
        let key = OsKeyStore.get_or_create_key()?;
        let encrypted = secret::encrypt(&key, &session.refresh_token)?;
        persist(app, &runtime.config, encrypted)?;
    }
    Ok(())
}

struct HandshakeOutcome {
    account_email: String,
    refresh_token: String,
    access_token: String,
    expires_in_secs: u64,
}

/// Starts the OAuth "installed application" handshake: opens the system
/// browser to Google's consent screen and waits on a loopback listener for
/// the redirect. Returns once the whole flow finishes — including the token
/// exchange and persisting the connection — or fails, so the frontend's
/// `invoke` promise simply resolves/rejects rather than needing a separate
/// completion event.
pub async fn connect<C, K>(
    app: AppHandle,
    state: &GmailState,
    registry: JobRegistry,
    client: C,
    keys: K,
) -> Result<String>
where
    C: GoogleApi + 'static,
    K: KeyStore + 'static,
{
    let (client_id, client_secret) = client_credentials()?;

    {
        let runtime = state.0.lock().unwrap();
        match &runtime.session {
            Session::Connected(_) => return Err(Error::GmailAlreadyConnected),
            Session::Connecting { .. } => return Err(Error::GmailAuthInProgress),
            Session::Disconnected => {}
        }
    }

    let pkce = oauth::generate_pkce();
    let csrf_state = oauth::generate_state();
    let (port, listener) = oauth::bind_loopback().await?;
    let redirect_uri = oauth::redirect_uri(port);
    let authorize_url = oauth::authorize_url(&client_id, &redirect_uri, &csrf_state, &pkce);

    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut runtime = state.0.lock().unwrap();
        runtime.session = Session::Connecting { cancel: cancel_tx };
    }

    let handshake = run_handshake(
        &client,
        listener,
        &csrf_state,
        &redirect_uri,
        cancel_rx,
        &client_id,
        client_secret.as_deref(),
        &pkce.verifier,
        &authorize_url,
    )
    .await;

    let outcome = match handshake {
        Ok(outcome) => outcome,
        Err(error) => {
            let mut runtime = state.0.lock().unwrap();
            runtime.session = Session::Disconnected;
            return Err(error);
        }
    };

    let email = outcome.account_email.clone();
    finish_connect(&app, state, &registry, client, keys, outcome).await?;
    Ok(email)
}

#[allow(clippy::too_many_arguments)]
async fn run_handshake(
    client: &impl GoogleApi,
    listener: tokio::net::TcpListener,
    csrf_state: &str,
    redirect_uri: &str,
    cancel_rx: oneshot::Receiver<()>,
    client_id: &str,
    client_secret: Option<&str>,
    code_verifier: &str,
    authorize_url: &str,
) -> Result<HandshakeOutcome> {
    if let Err(error) = tauri_plugin_opener::open_url(authorize_url, None::<&str>) {
        return Err(Error::GmailAuthFailed(format!(
            "could not open the system browser: {error}"
        )));
    }

    let code = tokio::select! {
        result = oauth::accept_callback(listener, csrf_state) => result?,
        _ = cancel_rx => return Err(Error::GmailAuthCancelled),
        _ = tokio::time::sleep(AUTH_TIMEOUT) => return Err(Error::GmailAuthTimedOut),
    };

    let tokens = client
        .exchange_code(ExchangeCodeParams {
            client_id,
            client_secret,
            code: &code,
            code_verifier,
            redirect_uri,
        })
        .await?;
    let refresh_token = tokens
        .refresh_token
        .ok_or_else(|| Error::GmailAuthFailed("Google did not return a refresh token".into()))?;
    let profile = client.get_profile(&tokens.access_token).await?;

    Ok(HandshakeOutcome {
        account_email: profile.email_address,
        refresh_token,
        access_token: tokens.access_token,
        expires_in_secs: tokens.expires_in_secs,
    })
}

async fn finish_connect<C, K>(
    app: &AppHandle,
    state: &GmailState,
    registry: &JobRegistry,
    client: C,
    keys: K,
    outcome: HandshakeOutcome,
) -> Result<()>
where
    C: GoogleApi + 'static,
    K: KeyStore + 'static,
{
    let key = keys.get_or_create_key()?;
    let encrypted = secret::encrypt(&key, &outcome.refresh_token)?;

    let job_id;
    {
        let mut runtime = state.0.lock().unwrap();
        runtime.config.account_email = Some(outcome.account_email);
        runtime.config.last_history_id = None;
        persist(app, &runtime.config, encrypted)?;

        job_id = start_polling(app.clone(), registry.clone(), client, keys);
        runtime.session = Session::Connected(ConnectedSession {
            refresh_token: outcome.refresh_token,
            access_token: Some(outcome.access_token),
            access_token_expires_at: Some(
                SystemTime::now() + Duration::from_secs(outcome.expires_in_secs),
            ),
            poll_job_id: Some(job_id),
        });
    }
    Ok(())
}

pub fn cancel_connect(state: &GmailState) -> Result<()> {
    let mut runtime = state.0.lock().unwrap();
    match std::mem::replace(&mut runtime.session, Session::Disconnected) {
        Session::Connecting { cancel } => {
            let _ = cancel.send(());
            Ok(())
        }
        other => {
            runtime.session = other;
            Err(Error::GmailNotConnecting)
        }
    }
}

pub async fn disconnect(
    app: &AppHandle,
    state: &GmailState,
    registry: &JobRegistry,
    client: &impl GoogleApi,
    keys: &impl KeyStore,
) -> Result<()> {
    let (refresh_token, poll_job_id) = {
        let mut runtime = state.0.lock().unwrap();
        match std::mem::replace(&mut runtime.session, Session::Disconnected) {
            Session::Connected(session) => (session.refresh_token, session.poll_job_id),
            other => {
                runtime.session = other;
                return Err(Error::GmailNotConnected);
            }
        }
    };

    if let Some(job_id) = poll_job_id {
        let _ = registry.cancel(&job_id);
    }
    client.revoke(&refresh_token).await;
    keys.delete_key()?;
    delete_file(app)?;
    Ok(())
}

/// Loads a previously connected session from disk at startup and, if one
/// exists, resumes polling — a connector that stops the moment the window
/// closes and the process is later relaunched would defeat the point of
/// running as a background job in the first place.
pub async fn resume<C, K>(app: AppHandle, registry: JobRegistry, client: C, keys: K) -> Result<()>
where
    C: GoogleApi + 'static,
    K: KeyStore + 'static,
{
    let Some(file) = read_file(&app)? else {
        return Ok(());
    };

    let key = keys.get_or_create_key()?;
    let refresh_token = secret::decrypt(&key, &file.encrypted_refresh_token)?;

    let gmail = app.state::<GmailState>();
    let job_id;
    {
        let mut runtime = gmail.0.lock().unwrap();
        runtime.config = Config {
            account_email: Some(file.account_email),
            last_history_id: file.last_history_id,
            poll_interval_secs: file.poll_interval_secs,
            rules: file.rules,
        };
        job_id = start_polling(app.clone(), registry, client, keys);
        runtime.session = Session::Connected(ConnectedSession {
            refresh_token,
            access_token: None,
            access_token_expires_at: None,
            poll_job_id: Some(job_id),
        });
    }
    Ok(())
}

fn start_polling<C, K>(app: AppHandle, registry: JobRegistry, client: C, keys: K) -> JobId
where
    C: GoogleApi + 'static,
    K: KeyStore + 'static,
{
    jobs::spawn(app.clone(), registry, "gmail", move |ctx| async move {
        loop {
            ctx.checkpoint()?;
            match poll_cycle(&app, &ctx, &client, &keys).await {
                PollCycleOutcome::Continue { wait_secs } => {
                    tokio::time::sleep(Duration::from_secs(wait_secs)).await;
                }
                PollCycleOutcome::Stopped => return Ok(()),
            }
        }
    })
}

enum PollCycleOutcome {
    Continue { wait_secs: u64 },
    Stopped,
}

/// One poll iteration. Never holds the state mutex across an `await` —
/// `std::sync::MutexGuard` is not `Send`, and this future is spawned onto a
/// multi-threaded runtime — so it snapshots what it needs, does the async
/// work with no lock held, then reacquires the lock only for the plain,
/// synchronous write-back.
async fn poll_cycle<S: EventSink>(
    app: &AppHandle,
    sink: &jobs::JobContext<S>,
    client: &impl GoogleApi,
    keys: &impl KeyStore,
) -> PollCycleOutcome {
    let gmail = app.state::<GmailState>();

    struct Snapshot {
        checkpoint: PollCheckpoint,
        rules: NotificationRules,
        poll_interval_secs: u64,
        refresh_token: String,
        access_token: Option<String>,
        access_token_expires_at: Option<SystemTime>,
    }

    let snapshot = {
        let runtime = gmail.0.lock().unwrap();
        let Session::Connected(session) = &runtime.session else {
            return PollCycleOutcome::Stopped;
        };
        Snapshot {
            checkpoint: PollCheckpoint {
                last_history_id: runtime.config.last_history_id.clone(),
            },
            rules: runtime.config.rules.clone(),
            poll_interval_secs: runtime.config.poll_interval_secs,
            refresh_token: session.refresh_token.clone(),
            access_token: session.access_token.clone(),
            access_token_expires_at: session.access_token_expires_at,
        }
    };

    let (client_id, client_secret) = match client_credentials() {
        Ok(creds) => creds,
        Err(error) => {
            log::warn!("gmail: {error}");
            return PollCycleOutcome::Continue {
                wait_secs: snapshot.poll_interval_secs,
            };
        }
    };

    let (access_token, expires_at, new_refresh_token) = match ensure_fresh_access_token(
        client,
        &client_id,
        client_secret.as_deref(),
        &snapshot.refresh_token,
        snapshot.access_token,
        snapshot.access_token_expires_at,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            // Transient network trouble and a permanently revoked grant both
            // land here; there is no reliable way to tell them apart from the
            // error alone, so this always retries rather than risk silently
            // disconnecting an account over a blip. A user who really did
            // revoke access sees the next poll fail the same way and can
            // disconnect from Settings.
            log::warn!("gmail: could not refresh access token, will retry: {error}");
            return PollCycleOutcome::Continue {
                wait_secs: snapshot.poll_interval_secs,
            };
        }
    };

    let mut checkpoint = snapshot.checkpoint;
    let notifications =
        match poll::poll_once(client, &access_token, &mut checkpoint, &snapshot.rules).await {
            Ok(notifications) => notifications,
            Err(error) => {
                log::warn!("gmail: poll failed, will retry: {error}");
                Vec::new()
            }
        };

    {
        let mut runtime = gmail.0.lock().unwrap();
        runtime.config.last_history_id = checkpoint.last_history_id;
        if let Session::Connected(session) = &mut runtime.session {
            session.access_token = Some(access_token);
            session.access_token_expires_at = Some(expires_at);
            if let Some(refreshed) = new_refresh_token {
                session.refresh_token = refreshed;
            }
            if let Ok(key) = keys.get_or_create_key() {
                if let Ok(encrypted) = secret::encrypt(&key, &session.refresh_token) {
                    let _ = persist(app, &runtime.config, encrypted);
                }
            }
        }
    }

    for notification in &notifications {
        sink.report(
            NotificationStatus::Running,
            notification.from.clone(),
            Some(notification.subject.clone()),
            None,
        );
    }

    PollCycleOutcome::Continue {
        wait_secs: snapshot.poll_interval_secs,
    }
}

fn needs_refresh(expires_at: Option<SystemTime>, now: SystemTime) -> bool {
    match expires_at {
        None => true,
        // Refreshes a minute early so a call already in flight does not race
        // token expiry.
        Some(expires_at) => expires_at <= now + Duration::from_secs(60),
    }
}

/// Reuses the cached access token when it is still fresh, otherwise spends
/// one refresh-token round trip. Returns the token to use, its new expiry,
/// and a replacement refresh token when Google issued one — refresh calls
/// usually do not, but nothing here assumes it never will.
async fn ensure_fresh_access_token(
    client: &impl GoogleApi,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
    access_token: Option<String>,
    access_token_expires_at: Option<SystemTime>,
) -> Result<(String, SystemTime, Option<String>)> {
    let now = SystemTime::now();
    if let Some(token) = access_token {
        if !needs_refresh(access_token_expires_at, now) {
            return Ok((token, access_token_expires_at.unwrap(), None));
        }
    }

    let response = client
        .refresh_access_token(RefreshParams {
            client_id,
            client_secret,
            refresh_token,
        })
        .await?;
    let expires_at = now + Duration::from_secs(response.expires_in_secs);
    Ok((response.access_token, expires_at, response.refresh_token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use api::fakes::FakeGoogleApi;
    use api::TokenResponse;

    #[test]
    fn needs_refresh_when_expired_or_missing() {
        let now = SystemTime::now();
        assert!(needs_refresh(None, now));
        assert!(needs_refresh(Some(now), now));
        assert!(!needs_refresh(Some(now + Duration::from_secs(3600)), now));
    }

    #[tokio::test]
    async fn ensure_fresh_access_token_reuses_a_token_that_is_not_near_expiry() {
        let client = FakeGoogleApi::default();
        let now = SystemTime::now();
        let (token, _, _) = ensure_fresh_access_token(
            &client,
            "id",
            None,
            "refresh",
            Some("still-good".into()),
            Some(now + Duration::from_secs(3600)),
        )
        .await
        .unwrap();
        assert_eq!(token, "still-good");
        assert!(client.refreshed_tokens.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn ensure_fresh_access_token_refreshes_when_expired() {
        let client = FakeGoogleApi::default();
        *client.next_token.lock().unwrap() = Some(Ok(TokenResponse {
            access_token: "new-token".into(),
            refresh_token: None,
            expires_in_secs: 3600,
        }));
        let now = SystemTime::now();
        let (token, expires_at, _) = ensure_fresh_access_token(
            &client,
            "id",
            None,
            "refresh",
            Some("stale".into()),
            Some(now - Duration::from_secs(10)),
        )
        .await
        .unwrap();
        assert_eq!(token, "new-token");
        assert!(expires_at > now);
        assert_eq!(client.refreshed_tokens.lock().unwrap()[0], "refresh");
    }

    #[tokio::test]
    async fn ensure_fresh_access_token_refreshes_when_no_token_is_cached_yet() {
        let client = FakeGoogleApi::default();
        *client.next_token.lock().unwrap() = Some(Ok(TokenResponse {
            access_token: "first-token".into(),
            refresh_token: Some("rotated".into()),
            expires_in_secs: 100,
        }));
        let (token, _, rotated) =
            ensure_fresh_access_token(&client, "id", None, "refresh", None, None)
                .await
                .unwrap();
        assert_eq!(token, "first-token");
        assert_eq!(rotated, Some("rotated".to_string()));
    }

    #[test]
    fn cancel_connect_fails_when_nothing_is_connecting() {
        let state = GmailState::default();
        assert!(matches!(
            cancel_connect(&state),
            Err(Error::GmailNotConnecting)
        ));
    }

    // `resolve_credentials` is the pure decision logic behind
    // `client_credentials`, tested directly with fabricated inputs rather
    // than through real env vars — `std::env` is process-global mutable
    // state, and `cargo test` runs tests in parallel threads by default, so
    // tests that actually called `set_var`/`remove_var` raced each other
    // here previously (passed locally, flaked in CI). Nothing below touches
    // the environment.

    #[test]
    fn resolve_credentials_prefers_the_env_override() {
        let result = resolve_credentials(
            Some("env-id".into()),
            Some("env-secret".into()),
            CompiledConfig {
                client_id: "compiled-id".into(),
                client_secret: "compiled-secret".into(),
            },
        );
        assert_eq!(
            result.unwrap(),
            ("env-id".to_string(), Some("env-secret".to_string()))
        );
    }

    #[test]
    fn resolve_credentials_falls_back_to_the_compiled_default() {
        let result = resolve_credentials(
            None,
            None,
            CompiledConfig {
                client_id: "compiled-id".into(),
                client_secret: "compiled-secret".into(),
            },
        );
        assert_eq!(
            result.unwrap(),
            (
                "compiled-id".to_string(),
                Some("compiled-secret".to_string())
            )
        );
    }

    #[test]
    fn resolve_credentials_errors_when_nothing_is_configured() {
        let result = resolve_credentials(None, None, CompiledConfig::default());
        assert!(matches!(result, Err(Error::GmailClientNotConfigured)));
    }

    #[test]
    fn the_committed_gmail_config_toml_parses_and_has_a_client_id() {
        // Guards against a typo in the tracked file silently falling back to
        // "not configured" instead of failing loudly.
        let compiled = compiled_credentials();
        assert!(!compiled.client_id.is_empty());
    }
}
