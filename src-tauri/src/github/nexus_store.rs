use async_trait::async_trait;
use reqwest::header::{HeaderValue, ETAG, IF_MATCH};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};
use crate::nexus_auth;

use super::token_store::{KeyringTokenStore, StoredToken, TokenStore};

const NEXUS: &str = "https://nexus.eresea.net/api/v1";
const POINTER_KEY: &str = "github.nexusCredential";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialPointer {
    user_id: String,
    credential_id: String,
    username: String,
    #[serde(default)]
    pending_upload: bool,
}

#[derive(Deserialize)]
struct CredentialCreated {
    id: String,
}

#[derive(Deserialize)]
struct SecretResponse {
    secret: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialCreate {
    namespace: &'static str,
    #[serde(rename = "type")]
    credential_type: &'static str,
    label: String,
    metadata: serde_json::Value,
    secret: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretReplace<'a> {
    secret: &'a str,
}

pub struct NexusGitHubTokenStore {
    app: AppHandle,
    http: reqwest::Client,
}

impl NexusGitHubTokenStore {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("Nexus HTTP client configuration is valid"),
        }
    }

    pub async fn connection_state(&self) -> Result<(Option<String>, bool, bool)> {
        let local = KeyringTokenStore.get().await?;
        let Some(pointer) = self.pointer()? else {
            return Ok((local.map(|token| token.username), false, false));
        };
        let same_user = self.current_user_id().await?.as_deref() == Some(pointer.user_id.as_str());
        if !same_user {
            return Ok((local.map(|token| token.username), false, false));
        }
        let username = local.map(|token| token.username).or(Some(pointer.username));
        Ok((username, !pointer.pending_upload, pointer.pending_upload))
    }

    fn pointer(&self) -> Result<Option<CredentialPointer>> {
        self.app
            .store("settings.json")
            .map_err(|error| Error::NexusAuth(error.to_string()))?
            .get(POINTER_KEY)
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| Error::NexusAuth(error.to_string()))
    }

    fn save_pointer(&self, pointer: &CredentialPointer) -> Result<()> {
        let store = self
            .app
            .store("settings.json")
            .map_err(|error| Error::NexusAuth(error.to_string()))?;
        store.set(POINTER_KEY, json!(pointer));
        store
            .save()
            .map_err(|error| Error::NexusAuth(error.to_string()))
    }

    fn clear_pointer(&self) -> Result<()> {
        let store = self
            .app
            .store("settings.json")
            .map_err(|error| Error::NexusAuth(error.to_string()))?;
        store.delete(POINTER_KEY);
        store
            .save()
            .map_err(|error| Error::NexusAuth(error.to_string()))
    }

    async fn current_user_id(&self) -> Result<Option<String>> {
        Ok(nexus_auth::status()?.user_id)
    }

    async fn credential_secret(
        &self,
        token: &str,
        pointer: &CredentialPointer,
    ) -> Result<(StoredToken, Option<String>)> {
        let response = self
            .http
            .get(format!(
                "{NEXUS}/credentials/{}/secret",
                pointer.credential_id
            ))
            .bearer_auth(token)
            .send()
            .await
            .map_err(nexus_request_error)?;
        if response.status() == StatusCode::FORBIDDEN || response.status() == StatusCode::NOT_FOUND
        {
            return Err(Error::NexusAuth(
                "GitHub credential has not been granted to Relay".into(),
            ));
        }
        let response = response.error_for_status().map_err(nexus_request_error)?;
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body: SecretResponse = response.json().await.map_err(nexus_request_error)?;
        let token_bundle = serde_json::from_str(&body.secret)
            .map_err(|_| Error::NexusAuth("stored GitHub credential is invalid".into()))?;
        Ok((token_bundle, etag))
    }

    async fn create_credential(
        &self,
        token: &str,
        stored: &StoredToken,
        user_id: String,
    ) -> Result<CredentialPointer> {
        let secret =
            serde_json::to_string(stored).map_err(|error| Error::NexusAuth(error.to_string()))?;
        let request = CredentialCreate {
            namespace: "github",
            credential_type: "oauth-token-bundle",
            label: format!("GitHub — {}", stored.username),
            metadata: json!({ "username": stored.username }),
            secret,
        };
        let response = self
            .http
            .post(format!("{NEXUS}/credentials"))
            .bearer_auth(token)
            .json(&request)
            .send()
            .await
            .map_err(nexus_request_error)?
            .error_for_status()
            .map_err(nexus_request_error)?;
        let created: CredentialCreated = response.json().await.map_err(nexus_request_error)?;
        let pointer = CredentialPointer {
            user_id,
            credential_id: created.id,
            username: stored.username.clone(),
            pending_upload: true,
        };
        self.save_pointer(&pointer)?;
        Ok(pointer)
    }

    async fn try_upload(
        &self,
        token: &str,
        pointer: &mut CredentialPointer,
        stored: &StoredToken,
    ) -> Result<bool> {
        let etag = match self.credential_secret(token, pointer).await {
            Ok((_, Some(etag))) => etag,
            _ => return Ok(false),
        };
        let revision = HeaderValue::from_str(&etag).map_err(|_| {
            Error::NexusAuth("Nexus returned an invalid credential revision".into())
        })?;
        let secret =
            serde_json::to_string(stored).map_err(|error| Error::NexusAuth(error.to_string()))?;
        let response = self
            .http
            .put(format!(
                "{NEXUS}/credentials/{}/secret",
                pointer.credential_id
            ))
            .bearer_auth(token)
            .header(IF_MATCH, revision)
            .json(&SecretReplace { secret: &secret })
            .send()
            .await
            .map_err(nexus_request_error)?;
        if response.status() == StatusCode::FORBIDDEN || response.status() == StatusCode::CONFLICT {
            return Ok(false);
        }
        response.error_for_status().map_err(nexus_request_error)?;
        let (readback, _) = self.credential_secret(token, pointer).await?;
        if readback != *stored {
            return Ok(false);
        }
        pointer.pending_upload = false;
        self.save_pointer(pointer)?;
        KeyringTokenStore.clear().await?;
        Ok(true)
    }
}

#[async_trait]
impl TokenStore for NexusGitHubTokenStore {
    async fn get(&self) -> Result<Option<StoredToken>> {
        let Some(user_id) = self.current_user_id().await? else {
            return KeyringTokenStore.get().await;
        };
        let Some(mut pointer) = self.pointer()? else {
            let Some(local) = KeyringTokenStore.get().await? else {
                return Ok(None);
            };
            if let Ok(access_token) = nexus_auth::access_token(&self.app).await {
                if let Ok(mut pointer) =
                    self.create_credential(&access_token, &local, user_id).await
                {
                    let _ = self.try_upload(&access_token, &mut pointer, &local).await;
                }
            }
            return Ok(Some(local));
        };
        if pointer.user_id != user_id {
            return KeyringTokenStore.get().await;
        }
        let Some(local) = KeyringTokenStore.get().await? else {
            return match self
                .credential_secret(&nexus_auth::access_token(&self.app).await?, &pointer)
                .await
            {
                Ok((remote, _)) => Ok(Some(remote)),
                Err(error) => Err(error),
            };
        };
        if pointer.pending_upload {
            if let Ok(access_token) = nexus_auth::access_token(&self.app).await {
                let _ = self.try_upload(&access_token, &mut pointer, &local).await;
            }
            return Ok(Some(local));
        }
        let access_token = nexus_auth::access_token(&self.app).await?;
        match self.credential_secret(&access_token, &pointer).await {
            Ok((remote, _)) => {
                KeyringTokenStore.clear().await?;
                Ok(Some(remote))
            }
            Err(_) => Ok(Some(local)),
        }
    }

    async fn set(&self, stored: &StoredToken) -> Result<()> {
        KeyringTokenStore.set(stored).await?;
        let Some(user_id) = self.current_user_id().await? else {
            return Ok(());
        };
        let Ok(access_token) = nexus_auth::access_token(&self.app).await else {
            return Ok(());
        };
        let Some(mut pointer) = self.pointer()? else {
            if let Ok(mut pointer) = self.create_credential(&access_token, stored, user_id).await {
                let _ = self.try_upload(&access_token, &mut pointer, stored).await;
            }
            return Ok(());
        };
        if pointer.user_id != user_id {
            return Ok(());
        }
        pointer.pending_upload = true;
        self.save_pointer(&pointer)?;
        let _ = self.try_upload(&access_token, &mut pointer, stored).await;
        Ok(())
    }

    async fn clear(&self) -> Result<()> {
        KeyringTokenStore.clear().await?;
        self.clear_pointer()
    }
}

fn nexus_request_error(error: reqwest::Error) -> Error {
    Error::NexusAuth(format!(
        "credential request failed with {}",
        error
            .status()
            .map_or("network error".into(), |status| status.to_string())
    ))
}
