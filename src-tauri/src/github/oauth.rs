//! GitHub's OAuth Device Flow (RFC 8628): request a code, show it to the
//! user, poll until they approve it elsewhere.
//!
//! Device flow is the right shape for a desktop app with no way to host a
//! redirect URI: there is no loopback server to bind, no browser-launched
//! callback to catch, and no client secret to embed (device flow
//! authenticates the app by client id alone — RFC 8628 §3.1 — since the
//! human approving the code, not a redirect, is what proves consent). The
//! trade-off is a slower login (typing a code into a browser instead of one
//! click), which is the right one to make once, not per session.
//!
//! Wire parsing and the poll-outcome decision are pure functions so the
//! whole state machine — pending, slow down, approved, denied, expired — is
//! covered by `cargo test` with no live GitHub endpoint.

use serde::{Deserialize, Serialize};

/// Read-only-in-spirit: classic GitHub OAuth Apps have no scope that grants
/// read access to private repositories without also granting write access —
/// `repo` is the narrowest scope that can see private pull requests at all.
/// Users who only care about public repos can still connect; the connector
/// never writes anything back to GitHub with this token.
pub const SCOPE: &str = "repo admin:repo_hook";

const DEFAULT_POLL_INTERVAL_SECS: u64 = 5;

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    #[serde(default)]
    pub interval: Option<u64>,
}

impl DeviceCodeResponse {
    pub fn poll_interval_secs(&self) -> u64 {
        self.interval.unwrap_or(DEFAULT_POLL_INTERVAL_SECS)
    }
}

/// What Relay shows the user while it waits for them to approve the login
/// elsewhere. Deliberately excludes `device_code` — that value is only ever
/// needed core-side, to keep polling.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthorization {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub job_id: String,
}

/// The raw shape of `POST /login/oauth/access_token`, requested as JSON.
/// Success and every documented error share one flat object, distinguished
/// by which fields are present.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    #[serde(default)]
    pub access_token: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenOutcome {
    Approved {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: Option<u64>,
    },
    Pending,
    SlowDown,
    Denied,
    Expired,
    /// Any other error GitHub might return (bad client id, revoked app,
    /// ...). Carries the raw error code for logging.
    Failed(String),
}

/// Turns one poll response into a decision, so the loop driving the poll
/// (`poll::run_device_flow`) is one `match` on this rather than string
/// comparisons scattered through the async code.
pub fn interpret_token_response(response: TokenResponse) -> TokenOutcome {
    if let Some(access_token) = response.access_token {
        return TokenOutcome::Approved {
            access_token,
            refresh_token: response.refresh_token,
            expires_in: response.expires_in,
        };
    }
    match response.error.as_deref() {
        Some("authorization_pending") => TokenOutcome::Pending,
        Some("slow_down") => TokenOutcome::SlowDown,
        Some("access_denied") => TokenOutcome::Denied,
        Some("expired_token") => TokenOutcome::Expired,
        Some(other) => TokenOutcome::Failed(other.to_string()),
        None => TokenOutcome::Failed("empty response".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(access_token: Option<&str>, error: Option<&str>) -> TokenResponse {
        TokenResponse {
            access_token: access_token.map(str::to_string),
            refresh_token: None,
            expires_in: None,
            error: error.map(str::to_string),
        }
    }

    #[test]
    fn approved_carries_the_token() {
        let outcome = interpret_token_response(response(Some("gho_abc"), None));
        assert_eq!(
            outcome,
            TokenOutcome::Approved {
                access_token: "gho_abc".to_string(),
                refresh_token: None,
                expires_in: None,
            }
        );
    }

    #[test]
    fn pending_slow_down_denied_and_expired_are_distinguished() {
        assert_eq!(
            interpret_token_response(response(None, Some("authorization_pending"))),
            TokenOutcome::Pending
        );
        assert_eq!(
            interpret_token_response(response(None, Some("slow_down"))),
            TokenOutcome::SlowDown
        );
        assert_eq!(
            interpret_token_response(response(None, Some("access_denied"))),
            TokenOutcome::Denied
        );
        assert_eq!(
            interpret_token_response(response(None, Some("expired_token"))),
            TokenOutcome::Expired
        );
    }

    #[test]
    fn unknown_error_is_failed_with_the_raw_code() {
        assert_eq!(
            interpret_token_response(response(None, Some("incorrect_client_credentials"))),
            TokenOutcome::Failed("incorrect_client_credentials".to_string())
        );
    }

    #[test]
    fn default_poll_interval_is_five_seconds() {
        let response = DeviceCodeResponse {
            device_code: "d".into(),
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://github.com/login/device".into(),
            expires_in: 900,
            interval: None,
        };
        assert_eq!(response.poll_interval_secs(), 5);
    }
}
