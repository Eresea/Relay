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
    #[allow(
        dead_code,
        reason = "returned only by JobContext::checkpoint, which has no caller right now"
    )]
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
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
