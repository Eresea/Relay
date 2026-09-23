//! Rust-side transport for opaque encrypted vault sync with Nexus.

use std::fmt;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use reqwest::header::{HeaderValue, IF_MATCH};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const NEXUS_URL: &str = "https://nexus.eresea.net/";
const VAULT_PATH: &str = "api/v1/sync/vault";
const LATEST_PATH: &str = "api/v1/sync/vault/latest";
const MAX_CIPHERTEXT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRevision {
    pub revision_id: String,
    pub document_type: String,
    pub schema_version: u32,
    pub encryption_version: u32,
    pub ciphertext: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictBody {
    common_base: Option<SyncRevision>,
    current: Option<SyncRevision>,
}

#[derive(Debug)]
pub enum SyncError {
    Request(reqwest::Error),
    InvalidToken,
    InvalidBaseRevision,
    InvalidCiphertext,
    VaultUnavailable,
    CiphertextTooLarge,
    UnexpectedStatus(StatusCode),
    InvalidResponse(reqwest::Error),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Request(_) => write!(f, "Nexus sync request failed"),
            Self::InvalidToken => write!(f, "invalid Nexus access token"),
            Self::InvalidBaseRevision => write!(f, "invalid Nexus base revision"),
            Self::InvalidCiphertext => write!(f, "vault ciphertext is not valid base64"),
            Self::VaultUnavailable => write!(f, "could not read the local encrypted vault"),
            Self::CiphertextTooLarge => write!(f, "vault ciphertext exceeds Nexus's 512 KiB limit"),
            Self::UnexpectedStatus(status) => write!(f, "Nexus sync returned HTTP {status}"),
            Self::InvalidResponse(_) => write!(f, "Nexus returned an invalid sync response"),
        }
    }
}

impl std::error::Error for SyncError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Request(error) | Self::InvalidResponse(error) => Some(error),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for SyncError {
    fn from(error: reqwest::Error) -> Self {
        Self::Request(error)
    }
}

#[derive(Debug)]
pub enum PutResult {
    Saved(SyncRevision),
    Conflict {
        common_base: Option<SyncRevision>,
        current: Option<SyncRevision>,
    },
}

pub struct NexusSyncClient {
    http: reqwest::Client,
    base_url: Url,
}

impl NexusSyncClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("Nexus HTTP client configuration is valid"),
            base_url: Url::parse(NEXUS_URL).expect("static Nexus URL is valid"),
        }
    }

    #[cfg(test)]
    fn for_test(base_url: Url) -> Self {
        Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("Nexus HTTP client configuration is valid"),
            base_url,
        }
    }

    pub async fn latest(&self, access_token: &str) -> Result<Option<SyncRevision>, SyncError> {
        let response = self
            .http
            .get(
                self.base_url
                    .join(LATEST_PATH)
                    .expect("static path is valid"),
            )
            .bearer_auth(valid_token(access_token)?)
            .send()
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(SyncError::UnexpectedStatus(response.status()));
        }
        response
            .json()
            .await
            .map(Some)
            .map_err(SyncError::InvalidResponse)
    }

    /// Reads and uploads the local encrypted vault without exposing its bytes to the UI layer.
    pub async fn put_local_vault(
        &self,
        app: &AppHandle,
        access_token: &str,
        base_revision_id: Option<&str>,
    ) -> Result<PutResult, SyncError> {
        let ciphertext =
            crate::vault::sync_ciphertext(app).map_err(|_| SyncError::VaultUnavailable)?;
        self.put_vault(access_token, &ciphertext, base_revision_id)
            .await
    }

    async fn put_vault(
        &self,
        access_token: &str,
        ciphertext: &str,
        base_revision_id: Option<&str>,
    ) -> Result<PutResult, SyncError> {
        let decoded = BASE64
            .decode(ciphertext)
            .map_err(|_| SyncError::InvalidCiphertext)?;
        if decoded.len() > MAX_CIPHERTEXT_BYTES {
            return Err(SyncError::CiphertextTooLarge);
        }

        let url = self
            .base_url
            .join(VAULT_PATH)
            .expect("static path is valid");
        let mut request = self.http.put(url).bearer_auth(valid_token(access_token)?);
        if let Some(revision_id) = base_revision_id {
            let value = HeaderValue::from_str(&format!("\"{revision_id}\""))
                .map_err(|_| SyncError::InvalidBaseRevision)?;
            request = request.header(IF_MATCH, value);
        }
        let response = request
            .json(&PutBody {
                schema_version: 1,
                encryption_version: 1,
                ciphertext,
            })
            .send()
            .await?;

        if response.status() == StatusCode::CONFLICT {
            let body: ConflictBody = response.json().await.map_err(SyncError::InvalidResponse)?;
            return Ok(PutResult::Conflict {
                common_base: body.common_base,
                current: body.current,
            });
        }
        if !response.status().is_success() {
            return Err(SyncError::UnexpectedStatus(response.status()));
        }
        response
            .json()
            .await
            .map(PutResult::Saved)
            .map_err(SyncError::InvalidResponse)
    }
}

impl Default for NexusSyncClient {
    fn default() -> Self {
        Self::new()
    }
}

fn valid_token(token: &str) -> Result<&str, SyncError> {
    if token.is_empty() || HeaderValue::from_str(&format!("Bearer {token}")).is_err() {
        return Err(SyncError::InvalidToken);
    }
    Ok(token)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PutBody<'a> {
    schema_version: u32,
    encryption_version: u32,
    ciphertext: &'a str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn put_sends_if_match_and_returns_structured_conflict() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let read = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            assert!(request.contains("authorization: bearer test-token"));
            assert!(request.contains("if-match: \"rev-1\""));
            assert!(request.contains("\"ciphertext\":\"eyj2zxjzaw9uijoxfq==\""));

            let body = r#"{"commonBase":null,"current":null}"#;
            let response = format!(
                "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let client = NexusSyncClient::for_test(Url::parse(&format!("http://{address}/")).unwrap());
        let result = client
            .put_vault("test-token", "eyJ2ZXJzaW9uIjoxfQ==", Some("rev-1"))
            .await
            .unwrap();
        assert!(matches!(
            result,
            PutResult::Conflict {
                common_base: None,
                current: None
            }
        ));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn put_rejects_oversized_ciphertext_before_network_request() {
        let client = NexusSyncClient::new();
        let oversized = BASE64.encode(vec![0; MAX_CIPHERTEXT_BYTES + 1]);
        assert!(matches!(
            client.put_vault("test-token", &oversized, None).await,
            Err(SyncError::CiphertextTooLarge)
        ));
    }
}
