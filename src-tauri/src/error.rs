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
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
