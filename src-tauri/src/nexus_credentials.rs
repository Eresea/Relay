//! Connector credentials shared across devices through the Nexus vault.
//!
//! Relay creates each credential and grants itself read and replace access
//! (`credentials:grant:self`), so every device signed in to the same Nexus
//! account finds it through `/credentials/granted`. Two devices refreshing at
//! once are reconciled by the caller's `merge`, applied under the secret's ETag.

use reqwest::header::{ETAG, IF_MATCH};
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::error::{Error, Result};
use crate::nexus_auth::{self, NEXUS};

const CLIENT_ID: &str = "relay";
const CREDENTIAL_TYPE: &str = "oauth-token-bundle";
const SAVE_ATTEMPTS: usize = 3;

pub struct SharedCredential<T> {
    pub id: String,
    pub metadata: Value,
    pub secret: T,
}

/// Every `namespace` credential granted to Relay for the signed-in Nexus user.
pub async fn list<T: DeserializeOwned>(
    app: &AppHandle,
    namespace: &str,
) -> Result<Vec<SharedCredential<T>>> {
    let nexus = Nexus::open(app).await?;
    let mut credentials = Vec::new();
    for listed in nexus.granted(namespace).await? {
        let (secret, _) = nexus.read(&listed.id).await?;
        credentials.push(SharedCredential {
            id: listed.id,
            metadata: listed.metadata,
            secret,
        });
    }
    Ok(credentials)
}

/// Stores `value` in the credential whose metadata `matches`, merging it into
/// what another device may have written since, or creates one and grants it to
/// Relay. Returns the credential id.
pub async fn save<T: Serialize + DeserializeOwned + PartialEq>(
    app: &AppHandle,
    namespace: &str,
    label: String,
    metadata: Value,
    matches: impl Fn(&Value) -> bool,
    value: &T,
    merge: impl Fn(&T, &T) -> T,
) -> Result<String> {
    let nexus = Nexus::open(app).await?;
    let existing = nexus
        .granted(namespace)
        .await?
        .into_iter()
        .find(|credential| matches(&credential.metadata));
    let Some(existing) = existing else {
        // ponytail: a failed grant leaves an ungranted credential and the next save creates
        // another; clean those up through `/credentials` if they ever accumulate.
        let id = nexus.create(namespace, label, metadata, value).await?;
        nexus.grant(&id).await?;
        return Ok(id);
    };
    for _ in 0..SAVE_ATTEMPTS {
        let (current, etag) = nexus.read::<T>(&existing.id).await?;
        let merged = merge(&current, value);
        if merged == current || nexus.replace(&existing.id, &etag, &merged).await? {
            return Ok(existing.id);
        }
    }
    Err(Error::NexusAuth(
        "Nexus credential changed repeatedly; retry the sync".into(),
    ))
}

/// Grants Relay access to a credential it created earlier. A credential that
/// no longer exists has nothing to grant.
pub async fn grant(app: &AppHandle, id: &str) -> Result<()> {
    Nexus::open(app).await?.grant(id).await
}

/// Removes Relay's access to every matching credential, on every device.
pub async fn revoke(
    app: &AppHandle,
    namespace: &str,
    matches: impl Fn(&Value) -> bool,
) -> Result<()> {
    let nexus = Nexus::open(app).await?;
    for credential in nexus.granted(namespace).await? {
        if matches(&credential.metadata) {
            nexus.revoke(&credential.id).await?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct CredentialList {
    #[serde(default)]
    credentials: Vec<Listed>,
}

#[derive(Deserialize)]
struct Listed {
    id: String,
    namespace: String,
    #[serde(rename = "type")]
    credential_type: String,
    #[serde(default)]
    metadata: Value,
}

#[derive(Deserialize)]
struct Created {
    id: String,
}

#[derive(Deserialize)]
struct SecretResponse {
    secret: String,
}

struct Nexus {
    http: reqwest::Client,
    bearer: String,
}

impl Nexus {
    async fn open(app: &AppHandle) -> Result<Self> {
        Ok(Self {
            http: nexus_auth::http_client()?,
            bearer: nexus_auth::access_token(app).await?,
        })
    }

    fn url(path: &str) -> String {
        format!("{NEXUS}/api/v1/credentials{path}")
    }

    async fn granted(&self, namespace: &str) -> Result<Vec<Listed>> {
        let list: CredentialList = self
            .http
            .get(Self::url("/granted"))
            .bearer_auth(&self.bearer)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(request_error)?
            .json()
            .await
            .map_err(request_error)?;
        Ok(list
            .credentials
            .into_iter()
            .filter(|credential| {
                credential.namespace == namespace && credential.credential_type == CREDENTIAL_TYPE
            })
            .collect())
    }

    async fn read<T: DeserializeOwned>(&self, id: &str) -> Result<(T, String)> {
        let response = self
            .http
            .get(Self::url(&format!("/{id}/secret")))
            .bearer_auth(&self.bearer)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(request_error)?;
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| Error::NexusAuth("Nexus returned no credential revision".into()))?
            .to_owned();
        let body: SecretResponse = response.json().await.map_err(request_error)?;
        let secret = serde_json::from_str(&body.secret)
            .map_err(|_| Error::NexusAuth("a credential stored in Nexus is invalid".into()))?;
        Ok((secret, etag))
    }

    async fn create<T: Serialize>(
        &self,
        namespace: &str,
        label: String,
        metadata: Value,
        value: &T,
    ) -> Result<String> {
        let created: Created = self
            .http
            .post(Self::url(""))
            .bearer_auth(&self.bearer)
            .json(&json!({
                "namespace": namespace,
                "type": CREDENTIAL_TYPE,
                "label": label,
                "metadata": metadata,
                "secret": encode(value)?,
            }))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(request_error)?
            .json()
            .await
            .map_err(request_error)?;
        Ok(created.id)
    }

    /// `false` when another device replaced the secret since `etag` was read.
    async fn replace<T: Serialize>(&self, id: &str, etag: &str, value: &T) -> Result<bool> {
        let response = self
            .http
            .put(Self::url(&format!("/{id}/secret")))
            .bearer_auth(&self.bearer)
            .header(IF_MATCH, etag)
            .json(&json!({ "secret": encode(value)? }))
            .send()
            .await
            .map_err(request_error)?;
        if matches!(
            response.status(),
            StatusCode::CONFLICT | StatusCode::PRECONDITION_FAILED
        ) {
            return Ok(false);
        }
        response.error_for_status().map_err(request_error)?;
        Ok(true)
    }

    async fn grant(&self, id: &str) -> Result<()> {
        let response = self
            .http
            .put(Self::url(&format!("/{id}/grants/{CLIENT_ID}")))
            .bearer_auth(&self.bearer)
            .json(&json!({ "canRead": true, "canReplace": true }))
            .send()
            .await
            .map_err(request_error)?;
        if response.status() != StatusCode::NOT_FOUND {
            response.error_for_status().map_err(request_error)?;
        }
        Ok(())
    }

    async fn revoke(&self, id: &str) -> Result<()> {
        let response = self
            .http
            .delete(Self::url(&format!("/{id}/grants/{CLIENT_ID}")))
            .bearer_auth(&self.bearer)
            .send()
            .await
            .map_err(request_error)?;
        if response.status() != StatusCode::NOT_FOUND {
            response.error_for_status().map_err(request_error)?;
        }
        Ok(())
    }
}

fn encode<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).map_err(|error| Error::NexusAuth(error.to_string()))
}

fn request_error(error: reqwest::Error) -> Error {
    let status = error.status();
    if status == Some(StatusCode::FORBIDDEN) {
        return Error::NexusAuth(
            "Nexus denied credential sharing; sign in to Nexus again to approve Relay's sync permission"
                .into(),
        );
    }
    Error::NexusAuth(format!(
        "Nexus credential request failed{}",
        status.map_or(String::new(), |status| format!(" with HTTP {status}"))
    ))
}
