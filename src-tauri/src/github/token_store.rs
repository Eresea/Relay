//! Where the OAuth token lives at rest.
//!
//! The vault's pattern — AES-256-GCM under a key derived from a master
//! password — does not fit here: the poller has to read the token with
//! nobody around to unlock anything, so a password-gated store would just
//! stop the background job the moment Relay restarts. Instead the token goes
//! into the OS's own secret store (Keychain on macOS, Credential Manager on
//! Windows, the Secret Service on Linux) through the `keyring` crate — the
//! same place a browser or a git credential helper keeps a saved login, and
//! already access-controlled per-OS-user without Relay reimplementing that.
//!
//! Settings and rules are not secret and stay in `settings.json`, mirroring
//! every other preference; only the token itself goes through here.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const SERVICE: &str = "relay-github-connector";
const ACCOUNT: &str = "oauth-token";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredToken {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Epoch millis. `None` means the token does not expire — true of most
    /// OAuth Apps unless the organization opted into token expiration.
    #[serde(default)]
    pub expires_at: Option<u64>,
    pub username: String,
}

/// Abstracts the OS keychain so the connect/refresh/disconnect logic can be
/// exercised in tests without a real Secret Service, Keychain, or Credential
/// Manager present — the same reason `jobs` is written against `EventSink`
/// rather than `AppHandle` directly.
pub trait TokenStore: Send + Sync + 'static {
    fn get(&self) -> Result<Option<StoredToken>>;
    fn set(&self, token: &StoredToken) -> Result<()>;
    fn clear(&self) -> Result<()>;
}

#[derive(Default)]
pub struct KeyringTokenStore;

impl KeyringTokenStore {
    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| Error::TokenStore(e.to_string()))
    }
}

impl TokenStore for KeyringTokenStore {
    fn get(&self) -> Result<Option<StoredToken>> {
        match self.entry()?.get_password() {
            Ok(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|e| Error::TokenStore(e.to_string())),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::TokenStore(e.to_string())),
        }
    }

    fn set(&self, token: &StoredToken) -> Result<()> {
        let raw = serde_json::to_string(token).map_err(|e| Error::TokenStore(e.to_string()))?;
        self.entry()?
            .set_password(&raw)
            .map_err(|e| Error::TokenStore(e.to_string()))
    }

    fn clear(&self) -> Result<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::TokenStore(e.to_string())),
        }
    }
}

#[cfg(test)]
pub mod fake {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    pub struct FakeTokenStore(Mutex<Option<StoredToken>>);

    impl TokenStore for FakeTokenStore {
        fn get(&self) -> Result<Option<StoredToken>> {
            Ok(self.0.lock().unwrap().clone())
        }

        fn set(&self, token: &StoredToken) -> Result<()> {
            *self.0.lock().unwrap() = Some(token.clone());
            Ok(())
        }

        fn clear(&self) -> Result<()> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeTokenStore;
    use super::*;

    #[test]
    fn round_trips_through_the_fake_store() {
        let store = FakeTokenStore::default();
        assert_eq!(store.get().unwrap(), None);

        let token = StoredToken {
            access_token: "gho_abc".into(),
            refresh_token: Some("ghr_def".into()),
            expires_at: Some(1_000),
            username: "octocat".into(),
        };
        store.set(&token).unwrap();
        assert_eq!(store.get().unwrap(), Some(token));

        store.clear().unwrap();
        assert_eq!(store.get().unwrap(), None);
    }
}
