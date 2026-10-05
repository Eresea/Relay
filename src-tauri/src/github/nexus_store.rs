//! The GitHub token, shared across devices through the Nexus vault.
//!
//! The keychain copy keeps the connector working while Nexus is signed out or
//! unreachable; whenever Nexus answers, the newer of the two bundles wins and
//! both sides are brought up to it.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};
use crate::{nexus_auth, nexus_credentials};

use super::token_store::{KeyringTokenStore, StoredToken, TokenStore};

const NAMESPACE: &str = "github";
/// Where earlier versions kept the id of a credential they created without
/// granting it to Relay. Read once to grant it, then removed.
const LEGACY_POINTER_KEY: &str = "github.nexusCredential";

pub struct NexusGitHubTokenStore {
    app: AppHandle,
}

impl NexusGitHubTokenStore {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    /// The connected username, and whether the token is stored in Nexus.
    pub async fn connection_state(&self) -> Result<(Option<String>, bool)> {
        let (token, in_nexus) = self.load().await?;
        Ok((token.map(|token| token.username), in_nexus))
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

    async fn load(&self) -> Result<(Option<StoredToken>, bool)> {
        let local = KeyringTokenStore.get().await?;
        if !nexus_auth::status()?.connected {
            return Ok((local, false));
        }
        self.grant_legacy_credential().await;
        let remote = match nexus_credentials::list::<StoredToken>(&self.app, NAMESPACE).await {
            Ok(credentials) => credentials
                .into_iter()
                .next()
                .map(|credential| credential.secret),
            Err(error) => {
                log::warn!("github: could not read the Nexus credential: {error}");
                return Ok((local, false));
            }
        };
        let token = match (local, remote) {
            // Reads never upload: another device's disconnect revokes the shared copy, and
            // re-sharing this one would undo it. Connecting or a refresh shares it again.
            (local, None) => return Ok((local, false)),
            (None, Some(remote)) => remote,
            (Some(local), Some(remote)) => newer(&local, &remote),
        };
        KeyringTokenStore.set(&token).await?;
        Ok((Some(token), true))
    }

    async fn save_remote(&self, token: &StoredToken) -> Result<String> {
        let result = nexus_credentials::save(
            &self.app,
            NAMESPACE,
            format!("GitHub — {}", token.username),
            json!({ "username": token.username }),
            |_| true,
            token,
            newer,
        )
        .await;
        if let Err(error) = &result {
            log::warn!("github: could not store the token in Nexus: {error}");
        }
        result
    }

    async fn grant_legacy_credential(&self) {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyPointer {
            credential_id: String,
        }
        let Ok(store) = self.app.store("settings.json") else {
            return;
        };
        let Some(pointer) = store
            .get(LEGACY_POINTER_KEY)
            .and_then(|value| serde_json::from_value::<LegacyPointer>(value).ok())
        else {
            return;
        };
        match nexus_credentials::grant(&self.app, &pointer.credential_id).await {
            Ok(()) => {
                store.delete(LEGACY_POINTER_KEY);
                let _ = store.save();
            }
            Err(error) => {
                log::warn!("github: could not grant the earlier Nexus credential: {error}")
            }
        }
    }
}

/// The bundle that stays valid longer; a non-expiring token outlasts any
/// expiring one. Ties go to `incoming`, the side most recently written.
fn newer(existing: &StoredToken, incoming: &StoredToken) -> StoredToken {
    let lifetime = |token: &StoredToken| token.expires_at.unwrap_or(u64::MAX);
    if lifetime(incoming) >= lifetime(existing) {
        incoming.clone()
    } else {
        existing.clone()
    }
}

#[async_trait]
impl TokenStore for NexusGitHubTokenStore {
    async fn get(&self) -> Result<Option<StoredToken>> {
        Ok(self.load().await?.0)
    }

    async fn set(&self, stored: &StoredToken) -> Result<()> {
        KeyringTokenStore.set(stored).await?;
        if nexus_auth::status()?.connected {
            let _ = self.save_remote(stored).await;
        }
        Ok(())
    }

    /// Disconnects every device: a credential left granted in Nexus would be
    /// picked up again by the next read.
    async fn clear(&self) -> Result<()> {
        if nexus_auth::status()?.connected {
            nexus_credentials::revoke(&self.app, NAMESPACE, |_| true).await?;
        }
        KeyringTokenStore.clear().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(name: &str, expires_at: Option<u64>) -> StoredToken {
        StoredToken {
            access_token: name.into(),
            refresh_token: None,
            expires_at,
            username: "octocat".into(),
        }
    }

    #[test]
    fn newer_keeps_the_longest_lived_token() {
        assert_eq!(
            newer(&token("a", Some(5)), &token("b", Some(9))).access_token,
            "b"
        );
        assert_eq!(
            newer(&token("a", Some(9)), &token("b", Some(5))).access_token,
            "a"
        );
        assert_eq!(
            newer(&token("a", Some(9)), &token("b", None)).access_token,
            "b"
        );
        assert_eq!(
            newer(&token("a", None), &token("b", Some(9))).access_token,
            "a"
        );
        assert_eq!(
            newer(&token("a", None), &token("b", None)).access_token,
            "b"
        );
    }
}
