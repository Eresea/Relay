//! Where the GitHub token bundle lives.
//!
//! Signed in to Nexus, the bundle is a `github` connection on the account
//! (SDK `connections()`), created by Relay and therefore auto-granted to it.
//! Signed out, it stays in the local keychain. A local token found while
//! signed in is always newer than what Nexus holds (the store clears it after
//! every successful upload), so it is moved to Nexus and then removed.

use async_trait::async_trait;
use nexus_client::{
    AuthState, AvailableCredential, CredentialInput, Error as NexusError, NexusClient,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};
use crate::nexus_auth;

use super::token_store::{KeyringTokenStore, StoredToken, TokenStore};

const POINTER_KEY: &str = "github.nexusCredential";
const NAMESPACE: &str = "github";
const CREDENTIAL_TYPE: &str = "oauth-token-bundle";
const REPLACE_ATTEMPTS: usize = 3;

/// Which Nexus connection holds the bundle, and whose account it belongs to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialPointer {
    user_id: String,
    credential_id: String,
    username: String,
}

/// A GitHub connection in the account that another app created and Relay has
/// not been granted yet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableConnection {
    pub id: String,
    pub label: String,
    pub app: String,
}

impl From<AvailableCredential> for AvailableConnection {
    fn from(credential: AvailableCredential) -> Self {
        Self {
            id: credential.id,
            label: credential.label,
            app: credential
                .created_by
                .map_or_else(|| "another app".into(), |creator| creator.name),
        }
    }
}

pub struct NexusGitHubTokenStore {
    app: AppHandle,
}

impl NexusGitHubTokenStore {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    /// The connected username (if any) and, when not connected, a connection
    /// that could be requested from another app.
    pub async fn connection_state(&self) -> Result<(Option<String>, Option<AvailableConnection>)> {
        let local = KeyringTokenStore.get().await?;
        let Some((client, user_id)) = self.session().await else {
            return Ok((local.map(|token| token.username), None));
        };
        let pointer = self.pointer()?.filter(|pointer| pointer.user_id == user_id);
        if let Some(username) = local
            .map(|token| token.username)
            .or(pointer.map(|pointer| pointer.username))
        {
            return Ok((Some(username), None));
        }
        let available = match client.connections().available(NAMESPACE).await {
            Ok(list) => list.into_iter().next().map(Into::into),
            Err(error) => {
                log::debug!("could not list available GitHub connections: {error}");
                None
            }
        };
        Ok((None, available))
    }

    /// Loads a GitHub connection the account has already granted to Relay
    /// (created by Relay on another installation, or approved through the
    /// consent page) and remembers it. `None` when there is none.
    pub async fn adopt_granted(&self) -> Result<Option<StoredToken>> {
        let Some((client, user_id)) = self.session().await else {
            return Ok(None);
        };
        let connections = client.connections();
        let granted = connections
            .granted()
            .await
            .map_err(nexus_auth::nexus_error)?;
        for credential in granted.into_iter().filter(|credential| {
            credential.namespace == NAMESPACE && credential.revoked_at.is_none()
        }) {
            let secret = connections
                .read_secret(&credential.id)
                .await
                .map_err(nexus_auth::nexus_error)?;
            let Ok(stored) = serde_json::from_str::<StoredToken>(&secret.secret) else {
                continue;
            };
            self.save_pointer(&CredentialPointer {
                user_id,
                credential_id: credential.id,
                username: stored.username.clone(),
            })?;
            return Ok(Some(stored));
        }
        Ok(None)
    }

    pub async fn get_valid(&self) -> Result<Option<StoredToken>> {
        let Some(stored) = TokenStore::get(self).await? else {
            return Ok(None);
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if !super::poll::needs_refresh(stored.expires_at, now) {
            return Ok(Some(stored));
        }
        let settings = super::read_settings(&self.app);
        let client_id = super::rules::effective_client_id(&settings)
            .ok_or(Error::GithubClientIdNotConfigured)?;
        let client = self
            .app
            .state::<super::client::HttpGitHubClient>()
            .inner()
            .clone();
        let refreshed = super::poll::refresh_stored_token(&client, client_id, &stored).await?;
        TokenStore::set(self, &refreshed).await?;
        Ok(Some(refreshed))
    }

    /// The signed-in client and the account id, or `None` when signed out.
    async fn session(&self) -> Option<(NexusClient, String)> {
        let client = nexus_auth::client(&self.app).ok()?;
        let AuthState::SignedIn { .. } = client.auth_state() else {
            return None;
        };
        let user = client.user().await.ok().flatten()?;
        Some((client, user.sub))
    }

    fn pointer(&self) -> Result<Option<CredentialPointer>> {
        Ok(self
            .app
            .store("settings.json")
            .map_err(|error| Error::NexusAuth(error.to_string()))?
            .get(POINTER_KEY)
            .and_then(|value| serde_json::from_value(value).ok()))
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

    async fn read_remote(
        &self,
        client: &NexusClient,
        pointer: &CredentialPointer,
    ) -> Result<StoredToken> {
        let secret = client
            .connections()
            .read_secret(&pointer.credential_id)
            .await
            .map_err(nexus_auth::nexus_error)?;
        serde_json::from_str(&secret.secret)
            .map_err(|_| Error::NexusAuth("stored GitHub credential is invalid".into()))
    }

    /// Writes `stored` to Nexus: replaces the pointed-to connection, or
    /// creates one. A replace is conditional on the revision just read; when
    /// another installation wrote in between (`credential_revision_conflict`)
    /// the revision is re-read and the write retried.
    async fn upload(
        &self,
        client: &NexusClient,
        user_id: &str,
        stored: &StoredToken,
    ) -> Result<()> {
        let secret =
            serde_json::to_string(stored).map_err(|error| Error::NexusAuth(error.to_string()))?;
        let connections = client.connections();
        if let Some(pointer) = self.pointer()?.filter(|pointer| pointer.user_id == user_id) {
            let mut missing = false;
            for _ in 0..REPLACE_ATTEMPTS {
                let revision = match connections.read_secret(&pointer.credential_id).await {
                    Ok(current) => current.revision,
                    Err(NexusError::Api { status: 404, .. }) => {
                        missing = true;
                        break;
                    }
                    Err(error) => return Err(nexus_auth::nexus_error(error)),
                };
                match connections
                    .replace_secret(&pointer.credential_id, &secret, None, revision.as_deref())
                    .await
                {
                    Ok(_) => {
                        return self.save_pointer(&CredentialPointer {
                            username: stored.username.clone(),
                            ..pointer
                        })
                    }
                    Err(error) if error.is_revision_conflict() => {}
                    Err(error) => return Err(nexus_auth::nexus_error(error)),
                }
            }
            if !missing {
                return Err(Error::NexusAuth(
                    "GitHub credential changed while saving; try again".into(),
                ));
            }
        }
        let created = connections
            .create(&CredentialInput {
                namespace: NAMESPACE.into(),
                credential_type: CREDENTIAL_TYPE.into(),
                label: format!("GitHub — {}", stored.username),
                metadata: json!({ "username": stored.username }),
                secret,
                expires_at: None,
            })
            .await
            .map_err(nexus_auth::nexus_error)?;
        self.save_pointer(&CredentialPointer {
            user_id: user_id.to_owned(),
            credential_id: created.id,
            username: stored.username.clone(),
        })
    }
}

#[async_trait]
impl TokenStore for NexusGitHubTokenStore {
    async fn get(&self) -> Result<Option<StoredToken>> {
        let local = KeyringTokenStore.get().await?;
        let Some((client, user_id)) = self.session().await else {
            return Ok(local);
        };
        if let Some(local) = local {
            match self.upload(&client, &user_id, &local).await {
                Ok(()) => KeyringTokenStore.clear().await?,
                Err(error) => log::warn!("could not move the GitHub token to Nexus: {error}"),
            }
            return Ok(Some(local));
        }
        let Some(pointer) = self.pointer()?.filter(|pointer| pointer.user_id == user_id) else {
            return Ok(None);
        };
        self.read_remote(&client, &pointer).await.map(Some)
    }

    async fn set(&self, stored: &StoredToken) -> Result<()> {
        if let Some((client, user_id)) = self.session().await {
            match self.upload(&client, &user_id, stored).await {
                Ok(()) => return KeyringTokenStore.clear().await,
                Err(error) => log::warn!("could not save the GitHub token to Nexus: {error}"),
            }
        }
        KeyringTokenStore.set(stored).await
    }

    async fn clear(&self) -> Result<()> {
        KeyringTokenStore.clear().await?;
        self.clear_pointer()
    }
}
