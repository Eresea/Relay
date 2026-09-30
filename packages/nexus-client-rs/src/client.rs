use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::{Method, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use tokio::sync::watch;
use url::Url;

use crate::config::NexusConfig;
use crate::error::{BoxError, Error, Result};
use crate::pkce::{challenge_s256, random_token};
use crate::store::{KeyringTokenStore, StoredSession, TokenStore, User};

/// Refresh this many seconds before the access token expires.
const EARLY_RENEWAL_SECS: u64 = 30;
const PENDING_TTL: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthState {
    SignedOut,
    SignedIn { user: Option<User> },
}

/// Returned by [`NexusClient::sign_in`]; the flow completes in [`NexusClient::handle_callback`].
#[derive(Debug, Clone)]
pub struct PendingSignIn {
    pub authorize_url: String,
    pub state: String,
}

struct Pending {
    state: String,
    verifier: String,
    started: Instant,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: u64,
}

struct Inner {
    config: NexusConfig,
    http: reqwest::Client,
    store: Arc<dyn TokenStore>,
    session: Mutex<Option<StoredSession>>,
    pending: Mutex<Option<Pending>>,
    /// Single-flight: held for the duration of a refresh request.
    refresh: tokio::sync::Mutex<()>,
    state: watch::Sender<AuthState>,
}

/// Cheap to clone; all clones share state.
#[derive(Clone)]
pub struct NexusClient {
    inner: Arc<Inner>,
}

pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn fresh(s: &StoredSession) -> bool {
    s.expires_at > now_secs() + EARLY_RENEWAL_SECS
}

fn sign_in_state(s: &Option<StoredSession>) -> AuthState {
    match s {
        Some(s) => AuthState::SignedIn {
            user: s.user.clone(),
        },
        None => AuthState::SignedOut,
    }
}

pub(crate) async fn api_error(resp: Response) -> Error {
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let code = body
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if status == StatusCode::CONFLICT && code == "credential_revision_conflict" {
        return Error::RevisionConflict;
    }
    Error::Api {
        status: status.as_u16(),
        code,
        description: body
            .get("error_description")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }
}

/// Go encodes empty slices as `null`; treat that as an empty list.
pub(crate) fn null_as_empty<'de, D, T>(d: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(d)?.unwrap_or_default())
}

pub(crate) async fn ensure_ok(resp: Response) -> Result<Response> {
    if resp.status().is_success() {
        Ok(resp)
    } else {
        Err(api_error(resp).await)
    }
}

pub(crate) async fn json_ok<T: DeserializeOwned>(resp: Response) -> Result<T> {
    ensure_ok(resp).await?.json().await.map_err(Error::Http)
}

impl NexusClient {
    /// Loads any stored session; the initial [`AuthState`] is `SignedIn` if one exists.
    pub fn new(config: NexusConfig, store: Arc<dyn TokenStore>) -> Result<Self> {
        config.validate()?;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()?;
        let session = store.load()?;
        let (state, _) = watch::channel(sign_in_state(&session));
        Ok(Self {
            inner: Arc::new(Inner {
                config,
                http,
                store,
                session: Mutex::new(session),
                pending: Mutex::new(None),
                refresh: tokio::sync::Mutex::new(()),
                state,
            }),
        })
    }

    /// Uses the OS keychain entry named by `keyring_service` / `keyring_account`.
    pub fn with_keyring(config: NexusConfig) -> Result<Self> {
        let store = Arc::new(KeyringTokenStore::from_config(&config));
        Self::new(config, store)
    }

    pub fn config(&self) -> &NexusConfig {
        &self.inner.config
    }

    pub fn auth_state(&self) -> AuthState {
        self.inner.state.borrow().clone()
    }

    /// Receives every change of [`AuthState`] (sign-in, sign-out, revocation).
    pub fn watch(&self) -> watch::Receiver<AuthState> {
        self.inner.state.subscribe()
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}{}", self.inner.config.base(), path)
    }

    fn set_state(&self, next: AuthState) {
        self.inner.state.send_if_modified(|cur| {
            if *cur == next {
                false
            } else {
                *cur = next;
                true
            }
        });
    }

    fn cached(&self) -> Option<StoredSession> {
        self.inner.session.lock().unwrap().clone()
    }

    fn remember(&self, session: StoredSession) -> Result<()> {
        *self.inner.session.lock().unwrap() = Some(session.clone());
        self.set_state(AuthState::SignedIn {
            user: session.user.clone(),
        });
        self.inner.store.save(&session)
    }

    /// Drops local tokens and emits `SignedOut`. Used on `invalid_grant` and revocation.
    pub(crate) fn end_session_locally(&self) -> Result<()> {
        *self.inner.session.lock().unwrap() = None;
        self.set_state(AuthState::SignedOut);
        self.inner.store.clear()
    }

    // ---- sign-in ----------------------------------------------------------

    pub fn sign_in<F>(&self, opener: F) -> Result<PendingSignIn>
    where
        F: FnOnce(&str) -> std::result::Result<(), BoxError>,
    {
        self.sign_in_with_prompt(None, opener)
    }

    /// `prompt` is passed through (`none`, `login`, ...). `prompt=none` fails with
    /// `Authorization { code: "login_required" }` in the callback when there is no SSO session.
    pub fn sign_in_with_prompt<F>(&self, prompt: Option<&str>, opener: F) -> Result<PendingSignIn>
    where
        F: FnOnce(&str) -> std::result::Result<(), BoxError>,
    {
        let verifier = random_token(48);
        let state = random_token(32);
        let mut url =
            Url::parse(&self.url("/oauth/authorize")).map_err(|e| Error::Config(e.to_string()))?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("response_type", "code")
                .append_pair("client_id", &self.inner.config.client_id)
                .append_pair("redirect_uri", &self.inner.config.redirect_uri)
                .append_pair("scope", &self.inner.config.scopes.join(" "))
                .append_pair("state", &state)
                .append_pair("code_challenge", &challenge_s256(&verifier))
                .append_pair("code_challenge_method", "S256");
            if let Some(p) = prompt {
                q.append_pair("prompt", p);
            }
        }
        *self.inner.pending.lock().unwrap() = Some(Pending {
            state: state.clone(),
            verifier,
            started: Instant::now(),
        });
        if let Err(e) = opener(url.as_str()) {
            self.inner.pending.lock().unwrap().take();
            return Err(Error::Opener(e.to_string()));
        }
        Ok(PendingSignIn {
            authorize_url: url.into(),
            state,
        })
    }

    /// Completes sign-in from the deep-link URL. A callback with a wrong `state` is rejected and
    /// leaves the pending attempt intact.
    pub async fn handle_callback(&self, callback_url: &str) -> Result<()> {
        let cb = Url::parse(callback_url).map_err(|_| Error::InvalidCallback)?;
        let redirect = Url::parse(&self.inner.config.redirect_uri)
            .map_err(|e| Error::Config(e.to_string()))?;
        if cb.scheme() != redirect.scheme()
            || cb.host_str() != redirect.host_str()
            || cb.path() != redirect.path()
        {
            return Err(Error::InvalidCallback);
        }
        let params: HashMap<String, String> = cb.query_pairs().into_owned().collect();
        let pending = {
            let mut slot = self.inner.pending.lock().unwrap();
            let p = slot.as_ref().ok_or(Error::NoPendingSignIn)?;
            if params.get("state").map(String::as_str) != Some(p.state.as_str()) {
                return Err(Error::StateMismatch);
            }
            let expired = p.started.elapsed() > PENDING_TTL;
            let p = slot.take().unwrap();
            if expired {
                return Err(Error::SignInExpired);
            }
            p
        };
        if let Some(code) = params.get("error") {
            return Err(Error::Authorization {
                code: code.clone(),
                description: params.get("error_description").cloned(),
            });
        }
        let code = params
            .get("code")
            .filter(|c| !c.is_empty())
            .ok_or_else(|| Error::InvalidResponse("callback has no code".into()))?;
        let tokens = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("code_verifier", &pending.verifier),
                ("redirect_uri", &self.inner.config.redirect_uri),
            ])
            .await?;
        let refresh_token = tokens
            .refresh_token
            .ok_or_else(|| Error::InvalidResponse("token response has no refresh_token".into()))?;
        let mut session = StoredSession {
            access_token: tokens.access_token,
            refresh_token,
            expires_at: now_secs() + tokens.expires_in,
            user: None,
        };
        // Best effort: `user()` retries lazily.
        session.user = self.fetch_userinfo(&session.access_token).await.ok();
        self.remember(session)
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<TokenResponse> {
        let mut body = vec![("client_id", self.inner.config.client_id.as_str())];
        body.extend_from_slice(form);
        let resp = self
            .inner
            .http
            .post(self.url("/oauth/token"))
            .form(&body)
            .send()
            .await?;
        json_ok(resp).await
    }

    async fn fetch_userinfo(&self, token: &str) -> Result<User> {
        let resp = self
            .inner
            .http
            .get(self.url("/oauth/userinfo"))
            .bearer_auth(token)
            .send()
            .await?;
        json_ok(resp).await
    }

    // ---- tokens -----------------------------------------------------------

    /// A valid access token, refreshing (single-flight) when it expires within 30 s.
    pub async fn access_token(&self) -> Result<String> {
        if let Some(s) = self.cached() {
            if fresh(&s) {
                return Ok(s.access_token);
            }
        }
        self.refresh(None).await
    }

    /// Refresh after a 401 on `stale`; reuses a newer token if another caller already refreshed.
    pub(crate) async fn refresh_after_unauthorized(&self, stale: &str) -> Result<String> {
        self.refresh(Some(stale)).await
    }

    async fn refresh(&self, stale: Option<&str>) -> Result<String> {
        let _guard = self.inner.refresh.lock().await;
        let current = self.cached().ok_or(Error::NotSignedIn)?;
        if fresh(&current) && Some(current.access_token.as_str()) != stale {
            return Ok(current.access_token);
        }
        let resp = self
            .inner
            .http
            .post(self.url("/oauth/token"))
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", self.inner.config.client_id.as_str()),
                ("refresh_token", current.refresh_token.as_str()),
            ])
            .send()
            .await?;
        if !resp.status().is_success() {
            let err = api_error(resp).await;
            if matches!(&err, Error::Api { code, .. } if code == "invalid_grant") {
                self.end_session_locally()?;
                return Err(Error::SignedOut);
            }
            return Err(err); // transient: keep the session
        }
        let t: TokenResponse = resp.json().await?;
        let next = StoredSession {
            access_token: t.access_token.clone(),
            refresh_token: t.refresh_token.unwrap_or(current.refresh_token),
            expires_at: now_secs() + t.expires_in,
            user: current.user,
        };
        self.remember(next)?;
        Ok(t.access_token)
    }

    /// Authenticated request against the issuer. One refresh + retry on 401; a 401 never signs out
    /// by itself (only `invalid_grant` does). `build` may run twice.
    pub(crate) async fn authed<F>(&self, method: Method, path: &str, build: F) -> Result<Response>
    where
        F: Fn(RequestBuilder) -> RequestBuilder,
    {
        let send = |token: String| {
            build(
                self.inner
                    .http
                    .request(method.clone(), self.url(path))
                    .bearer_auth(token),
            )
            .send()
        };
        let token = self.access_token().await?;
        let resp = send(token.clone()).await?;
        if resp.status() != StatusCode::UNAUTHORIZED {
            return Ok(resp);
        }
        let next = self.refresh_after_unauthorized(&token).await?;
        Ok(send(next).await?)
    }

    // ---- user / sign-out --------------------------------------------------

    /// `None` when signed out. Uses the cached user, otherwise `GET /oauth/userinfo`.
    pub async fn user(&self) -> Result<Option<User>> {
        let Some(s) = self.cached() else {
            return Ok(None);
        };
        if s.user.is_some() {
            return Ok(s.user);
        }
        let resp = self.authed(Method::GET, "/oauth/userinfo", |r| r).await?;
        let user: User = json_ok(resp).await?;
        if let Some(mut cur) = self.cached() {
            cur.user = Some(user.clone());
            self.remember(cur)?;
        }
        Ok(Some(user))
    }

    /// App sign-out revokes this app's refresh token (`POST /oauth/revoke`); `everywhere` calls
    /// `POST /auth/logout-all`. Local tokens are always cleared; a remote failure is returned after.
    pub async fn sign_out(&self, everywhere: bool) -> Result<()> {
        let Some(s) = self.cached() else {
            return Ok(());
        };
        let remote: Result<()> = async {
            if everywhere {
                let resp = self.authed(Method::POST, "/auth/logout-all", |r| r).await?;
                ensure_ok(resp).await?;
            } else {
                let resp = self
                    .inner
                    .http
                    .post(self.url("/oauth/revoke"))
                    .form(&[
                        ("token", s.refresh_token.as_str()),
                        ("client_id", self.inner.config.client_id.as_str()),
                    ])
                    .send()
                    .await?;
                ensure_ok(resp).await?;
            }
            Ok(())
        }
        .await;
        self.end_session_locally()?;
        match remote {
            Err(Error::SignedOut | Error::NotSignedIn) => Ok(()),
            other => other,
        }
    }
}
