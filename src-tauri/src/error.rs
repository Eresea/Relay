use serde::{Serialize, Serializer};

use crate::jobs::JobId;

/// Every error that can cross the IPC boundary.
///
/// Tauri commands must return something `Serialize`, and a bare `String` loses
/// the ability to branch on the frontend, so errors carry a stable kind.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no window labelled `{0}`")]
    MissingWindow(&'static str),

    #[error("no job `{0}`")]
    UnknownJob(JobId),

    #[error("job `{0}` was cancelled")]
    JobCancelled(JobId),

    #[error(transparent)]
    Tauri(#[from] tauri::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error("no vault has been created yet")]
    VaultNotFound,

    #[error("a vault already exists")]
    VaultAlreadyExists,

    #[error("the vault is locked")]
    VaultLocked,

    #[error("master password must be at least 8 characters")]
    WeakMasterPassword,

    #[error("wrong master password")]
    WrongMasterPassword,

    #[error("no vault entry `{0}`")]
    UnknownVaultEntry(String),

    #[error("vault data is corrupt: {0}")]
    VaultCorrupt(String),

    #[error("select at least one character type")]
    InvalidPasswordOptions,

    #[error("encryption failed")]
    Crypto,

    #[error(
        "set a GitHub OAuth App client id (Device Flow enabled) in the connector's settings before connecting"
    )]
    GithubClientIdNotConfigured,

    #[error("the GitHub sign-in was declined")]
    GithubDeviceFlowDenied,

    #[error("the GitHub sign-in code expired before it was approved")]
    GithubDeviceFlowExpired,

    #[error("GitHub request failed: {0}")]
    GithubRequestFailed(String),

    #[error("GitHub rate limit reached; will retry on the next poll")]
    GithubRateLimited,

    #[error("could not access the system keychain: {0}")]
    TokenStore(String),

    #[error("OpenCloud request failed: {0}")]
    OpenCloud(String),

    #[error("the Gmail connector needs RELAY_GMAIL_CLIENT_ID set before it can connect")]
    GmailClientNotConfigured,

    #[error("a Gmail connect attempt is already in progress")]
    GmailAuthInProgress,

    #[error("Gmail is already connected")]
    GmailAlreadyConnected,

    #[error("no Gmail connect attempt is in progress")]
    GmailNotConnecting,

    #[error("Gmail sign-in was cancelled")]
    GmailAuthCancelled,

    #[error("Gmail sign-in timed out waiting for the browser")]
    GmailAuthTimedOut,

    #[error("Gmail sign-in state did not match — possible CSRF attempt")]
    GmailStateMismatch,

    #[error("Gmail sign-in failed: {0}")]
    GmailAuthFailed(String),

    #[error("Gmail is not connected")]
    GmailNotConnected,

    #[error("Gmail connector data is corrupt: {0}")]
    GmailCorrupt(String),

    #[error("could not reach a secure local secret store: {0}")]
    SecretStoreUnavailable(String),

    #[error("Gmail API request failed: {0}")]
    GmailApi(String),

    #[error("the stored Gmail history checkpoint has expired")]
    #[allow(
        dead_code,
        reason = "handled internally by gmail::poll before crossing IPC"
    )]
    GmailHistoryExpired,

    #[error(transparent)]
    Http(#[from] reqwest::Error),

    #[cfg(desktop)]
    #[error(transparent)]
    Updater(#[from] tauri_plugin_updater::Error),

    #[cfg(desktop)]
    #[error("invalid updater configuration: {0}")]
    UpdaterConfiguration(String),

    #[cfg(desktop)]
    #[error("no update is available")]
    NoUpdateAvailable,

    #[cfg(desktop)]
    #[error("the update has not finished downloading")]
    UpdateNotDownloaded,

    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),

    #[error("notification data is corrupt: {0}")]
    NotificationCorrupt(String),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
