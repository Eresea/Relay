use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

/// Boxed error returned by caller-provided callbacks (browser opener, event handler).
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid configuration: {0}")]
    Config(String),
    #[error("http request failed: {0}")]
    Http(#[from] reqwest::Error),
    /// Non-success response. `code` is the `error` field of the JSON body (or empty).
    #[error("nexus returned {status}: {code}")]
    Api {
        status: u16,
        code: String,
        description: Option<String>,
    },
    /// `409 credential_revision_conflict`: the secret changed since it was read. Re-read and retry.
    #[error("credential revision conflict")]
    RevisionConflict,
    #[error("not signed in")]
    NotSignedIn,
    /// The session ended (`invalid_grant`, `session.revoked`, close 4001). Local tokens are cleared.
    #[error("session ended; sign in again")]
    SignedOut,
    #[error("no sign-in in progress")]
    NoPendingSignIn,
    #[error("sign-in attempt expired")]
    SignInExpired,
    #[error("oauth state mismatch")]
    StateMismatch,
    #[error("callback url does not match the redirect uri")]
    InvalidCallback,
    /// The authorization server redirected back with `error=` (e.g. `login_required`, `access_denied`).
    #[error("authorization failed: {code}")]
    Authorization {
        code: String,
        description: Option<String>,
    },
    #[error("token store: {0}")]
    Store(String),
    #[error("could not open browser: {0}")]
    Opener(String),
    #[error("websocket: {0}")]
    WebSocket(String),
    #[error("event handler failed: {0}")]
    Handler(String),
    #[error("invalid response: {0}")]
    InvalidResponse(String),
}

impl Error {
    pub fn is_revision_conflict(&self) -> bool {
        matches!(self, Error::RevisionConflict)
    }

    pub fn is_signed_out(&self) -> bool {
        matches!(self, Error::SignedOut | Error::NotSignedIn)
    }
}
