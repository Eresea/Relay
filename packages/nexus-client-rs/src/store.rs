use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::config::NexusConfig;
use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct User {
    pub sub: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// What is persisted between runs. `expires_at` is epoch seconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: u64,
    #[serde(default)]
    pub user: Option<User>,
}

/// Where the session lives at rest. Implementations are synchronous and must be quick.
pub trait TokenStore: Send + Sync + 'static {
    fn load(&self) -> Result<Option<StoredSession>>;
    fn save(&self, session: &StoredSession) -> Result<()>;
    fn clear(&self) -> Result<()>;
}

/// OS keychain (Keychain / Credential Manager / Secret Service).
pub struct KeyringTokenStore {
    service: String,
    account: String,
}

impl KeyringTokenStore {
    pub fn new(service: impl Into<String>, account: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            account: account.into(),
        }
    }

    pub fn from_config(config: &NexusConfig) -> Self {
        Self::new(&config.keyring_service, &config.keyring_account)
    }

    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service, &self.account).map_err(|e| Error::Store(e.to_string()))
    }
}

impl TokenStore for KeyringTokenStore {
    fn load(&self) -> Result<Option<StoredSession>> {
        match self.entry()?.get_password() {
            Ok(raw) => serde_json::from_str(&raw)
                .map(Some)
                .map_err(|e| Error::Store(e.to_string())),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Store(e.to_string())),
        }
    }

    fn save(&self, session: &StoredSession) -> Result<()> {
        let raw = serde_json::to_string(session).map_err(|e| Error::Store(e.to_string()))?;
        self.entry()?
            .set_password(&raw)
            .map_err(|e| Error::Store(e.to_string()))
    }

    fn clear(&self) -> Result<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Store(e.to_string())),
        }
    }
}

/// Non-persistent store for tests and ephemeral tools.
#[derive(Default)]
pub struct MemoryTokenStore(Mutex<Option<StoredSession>>);

impl MemoryTokenStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_session(session: StoredSession) -> Self {
        Self(Mutex::new(Some(session)))
    }
}

impl TokenStore for MemoryTokenStore {
    fn load(&self) -> Result<Option<StoredSession>> {
        Ok(self.0.lock().unwrap().clone())
    }

    fn save(&self, session: &StoredSession) -> Result<()> {
        *self.0.lock().unwrap() = Some(session.clone());
        Ok(())
    }

    fn clear(&self) -> Result<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}
