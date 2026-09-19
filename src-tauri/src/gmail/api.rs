//! The Gmail and Google OAuth HTTP surface, behind a trait.
//!
//! `poll.rs`'s history-diffing logic and the token-refresh logic in `mod.rs`
//! are the parts worth unit testing, and neither needs a live network call to
//! prove correct — they need to prove they call the right endpoints with the
//! right arguments and react correctly to the responses. `GoogleApi` is the
//! seam: `HttpGoogleApi` is the real `reqwest`-backed implementation, and
//! `fakes::FakeGoogleApi` (test-only) is a canned-response stand-in, mirroring
//! how `jobs::spawn` is written against `EventSink` rather than `AppHandle`
//! directly.

use async_trait::async_trait;
use serde::Deserialize;

use crate::error::{Error, Result};

const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
const GMAIL_API_BASE: &str = "https://gmail.googleapis.com/gmail/v1";

/// The least-privileged scope that still lets the connector do its job: read
/// message headers and labels to decide whether a new message is important
/// and to show its sender/subject, without ever being able to fetch a body
/// or attachment. See docs/ARCHITECTURE.md's Gmail connector section for why
/// this was chosen over the broader `gmail.readonly`.
pub const SCOPE: &str = "https://www.googleapis.com/auth/gmail.metadata";

pub struct ExchangeCodeParams<'a> {
    pub client_id: &'a str,
    pub client_secret: Option<&'a str>,
    pub code: &'a str,
    pub code_verifier: &'a str,
    pub redirect_uri: &'a str,
}

pub struct RefreshParams<'a> {
    pub client_id: &'a str,
    pub client_secret: Option<&'a str>,
    pub refresh_token: &'a str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TokenResponse {
    pub access_token: String,
    /// Present when exchanging an auth code (with `access_type=offline` and
    /// `prompt=consent`); Google does not return a new one on every refresh.
    pub refresh_token: Option<String>,
    pub expires_in_secs: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub email_address: String,
    pub history_id: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct HistoryPage {
    pub added_message_ids: Vec<String>,
    /// Only present on the last page of a `history.list` response.
    pub history_id: Option<String>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MessageMeta {
    pub id: String,
    pub label_ids: Vec<String>,
    pub from: String,
    pub subject: String,
}

#[async_trait]
pub trait GoogleApi: Send + Sync {
    async fn exchange_code(&self, params: ExchangeCodeParams<'_>) -> Result<TokenResponse>;
    async fn refresh_access_token(&self, params: RefreshParams<'_>) -> Result<TokenResponse>;
    /// Best-effort: a revoke failure should never block disconnecting locally.
    async fn revoke(&self, token: &str);
    async fn get_profile(&self, access_token: &str) -> Result<Profile>;
    /// `start_history_id` is exclusive — only messages added after it come
    /// back. Restricted to the inbox and to additions, since that is the
    /// only history type the connector notifies on.
    async fn list_history(
        &self,
        access_token: &str,
        start_history_id: &str,
        page_token: Option<&str>,
    ) -> Result<HistoryPage>;
    async fn get_message_metadata(&self, access_token: &str, id: &str) -> Result<MessageMeta>;
}

#[derive(Default)]
pub struct HttpGoogleApi {
    client: reqwest::Client,
}

impl HttpGoogleApi {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl GoogleApi for HttpGoogleApi {
    async fn exchange_code(&self, params: ExchangeCodeParams<'_>) -> Result<TokenResponse> {
        let mut form = vec![
            ("client_id", params.client_id),
            ("code", params.code),
            ("code_verifier", params.code_verifier),
            ("redirect_uri", params.redirect_uri),
            ("grant_type", "authorization_code"),
        ];
        if let Some(secret) = params.client_secret {
            form.push(("client_secret", secret));
        }
        let response = self.client.post(TOKEN_ENDPOINT).form(&form).send().await?;
        parse_token_response(response).await
    }

    async fn refresh_access_token(&self, params: RefreshParams<'_>) -> Result<TokenResponse> {
        let mut form = vec![
            ("client_id", params.client_id),
            ("refresh_token", params.refresh_token),
            ("grant_type", "refresh_token"),
        ];
        if let Some(secret) = params.client_secret {
            form.push(("client_secret", secret));
        }
        let response = self.client.post(TOKEN_ENDPOINT).form(&form).send().await?;
        parse_token_response(response).await
    }

    async fn revoke(&self, token: &str) {
        if let Err(error) = self
            .client
            .post(REVOKE_ENDPOINT)
            .form(&[("token", token)])
            .send()
            .await
        {
            log::warn!("could not revoke the Gmail token with Google: {error}");
        }
    }

    async fn get_profile(&self, access_token: &str) -> Result<Profile> {
        #[derive(Deserialize)]
        struct Wire {
            #[serde(rename = "emailAddress")]
            email_address: String,
            #[serde(rename = "historyId")]
            history_id: String,
        }

        let response = self
            .client
            .get(format!("{GMAIL_API_BASE}/users/me/profile"))
            .bearer_auth(access_token)
            .send()
            .await?;
        let wire: Wire = ensure_success(response).await?.json().await?;
        Ok(Profile {
            email_address: wire.email_address,
            history_id: wire.history_id,
        })
    }

    async fn list_history(
        &self,
        access_token: &str,
        start_history_id: &str,
        page_token: Option<&str>,
    ) -> Result<HistoryPage> {
        #[derive(Deserialize, Default)]
        struct Wire {
            #[serde(default)]
            history: Vec<WireRecord>,
            #[serde(rename = "nextPageToken", default)]
            next_page_token: Option<String>,
            #[serde(rename = "historyId", default)]
            history_id: Option<String>,
        }
        #[derive(Deserialize)]
        struct WireRecord {
            #[serde(rename = "messagesAdded", default)]
            messages_added: Vec<WireMessageAdded>,
        }
        #[derive(Deserialize)]
        struct WireMessageAdded {
            message: WireMessageRef,
        }
        #[derive(Deserialize)]
        struct WireMessageRef {
            id: String,
        }

        let mut query = vec![
            ("startHistoryId", start_history_id),
            ("labelId", "INBOX"),
            ("historyTypes", "messageAdded"),
        ];
        if let Some(token) = page_token {
            query.push(("pageToken", token));
        }

        let response = self
            .client
            .get(format!("{GMAIL_API_BASE}/users/me/history"))
            .bearer_auth(access_token)
            .query(&query)
            .send()
            .await?;

        // A 404 here means startHistoryId has fallen out of Gmail's history
        // window (it keeps roughly a week) — the caller re-baselines rather
        // than treating this as a hard failure.
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(Error::GmailHistoryExpired);
        }

        let wire: Wire = ensure_success(response).await?.json().await?;
        let added_message_ids = wire
            .history
            .into_iter()
            .flat_map(|record| {
                record
                    .messages_added
                    .into_iter()
                    .map(|added| added.message.id)
            })
            .collect();
        Ok(HistoryPage {
            added_message_ids,
            history_id: wire.history_id,
            next_page_token: wire.next_page_token,
        })
    }

    async fn get_message_metadata(&self, access_token: &str, id: &str) -> Result<MessageMeta> {
        #[derive(Deserialize)]
        struct Wire {
            id: String,
            #[serde(rename = "labelIds", default)]
            label_ids: Vec<String>,
            #[serde(default)]
            payload: WirePayload,
        }
        #[derive(Deserialize, Default)]
        struct WirePayload {
            #[serde(default)]
            headers: Vec<WireHeader>,
        }
        #[derive(Deserialize)]
        struct WireHeader {
            name: String,
            value: String,
        }

        let response = self
            .client
            .get(format!("{GMAIL_API_BASE}/users/me/messages/{id}"))
            .bearer_auth(access_token)
            .query(&[
                ("format", "metadata"),
                ("metadataHeaders", "From"),
                ("metadataHeaders", "Subject"),
            ])
            .send()
            .await?;
        let wire: Wire = ensure_success(response).await?.json().await?;

        let header = |name: &str| {
            wire.payload
                .headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case(name))
                .map(|h| h.value.clone())
                .unwrap_or_default()
        };
        Ok(MessageMeta {
            id: wire.id,
            label_ids: wire.label_ids,
            from: header("From"),
            subject: header("Subject"),
        })
    }
}

async fn ensure_success(response: reqwest::Response) -> Result<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(Error::GmailApi(format!("{status}: {body}")))
}

async fn parse_token_response(response: reqwest::Response) -> Result<TokenResponse> {
    #[derive(Deserialize)]
    struct Wire {
        access_token: String,
        #[serde(default)]
        refresh_token: Option<String>,
        expires_in: u64,
    }
    let wire: Wire = ensure_success(response).await?.json().await?;
    Ok(TokenResponse {
        access_token: wire.access_token,
        refresh_token: wire.refresh_token,
        expires_in_secs: wire.expires_in,
    })
}

#[cfg(test)]
pub(crate) mod fakes {
    use std::sync::Mutex;

    use super::*;

    /// Records every call it receives and answers from a canned queue, so a
    /// test can both assert on what was asked (e.g. the exact
    /// `startHistoryId` used) and control what comes back (a page, a 404, an
    /// error) without any real HTTP traffic.
    #[derive(Default)]
    pub(crate) struct FakeGoogleApi {
        pub history_calls: Mutex<Vec<(String, Option<String>)>>,
        pub history_pages: Mutex<Vec<Result<HistoryPage>>>,
        pub messages: Mutex<std::collections::HashMap<String, MessageMeta>>,
        pub profile: Mutex<Option<Profile>>,
        pub refreshed_tokens: Mutex<Vec<String>>,
        pub next_token: Mutex<Option<Result<TokenResponse>>>,
    }

    fn clone_result<T: Clone>(result: &Result<T>) -> Result<T> {
        match result {
            Ok(value) => Ok(value.clone()),
            Err(Error::GmailHistoryExpired) => Err(Error::GmailHistoryExpired),
            Err(other) => Err(Error::GmailApi(other.to_string())),
        }
    }

    #[async_trait]
    impl GoogleApi for FakeGoogleApi {
        async fn exchange_code(&self, _params: ExchangeCodeParams<'_>) -> Result<TokenResponse> {
            self.next_token
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Err(Error::GmailApi("no fake token queued".into())))
        }

        async fn refresh_access_token(&self, params: RefreshParams<'_>) -> Result<TokenResponse> {
            self.refreshed_tokens
                .lock()
                .unwrap()
                .push(params.refresh_token.to_string());
            self.next_token
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Err(Error::GmailApi("no fake token queued".into())))
        }

        async fn revoke(&self, _token: &str) {}

        async fn get_profile(&self, _access_token: &str) -> Result<Profile> {
            self.profile
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| Error::GmailApi("no fake profile queued".into()))
        }

        async fn list_history(
            &self,
            _access_token: &str,
            start_history_id: &str,
            page_token: Option<&str>,
        ) -> Result<HistoryPage> {
            self.history_calls
                .lock()
                .unwrap()
                .push((start_history_id.to_string(), page_token.map(str::to_string)));
            let mut pages = self.history_pages.lock().unwrap();
            if pages.is_empty() {
                return Ok(HistoryPage::default());
            }
            clone_result(&pages.remove(0))
        }

        async fn get_message_metadata(&self, _access_token: &str, id: &str) -> Result<MessageMeta> {
            self.messages
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or_else(|| Error::GmailApi(format!("no fake message `{id}`")))
        }
    }
}
