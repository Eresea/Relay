use crate::error::{Error, Result};

/// No URL is hard-coded: everything is derived from `issuer`.
#[derive(Debug, Clone)]
pub struct NexusConfig {
    /// API base, e.g. `https://nexus.eresea.net/api/v1`. All routes are relative to it; the
    /// WebSocket URL is `{issuer origin}/ws/v1/user`.
    pub issuer: String,
    pub client_id: String,
    /// e.g. `relay://auth/callback`
    pub redirect_uri: String,
    pub scopes: Vec<String>,
    /// Keychain service name used by [`crate::KeyringTokenStore::from_config`].
    pub keyring_service: String,
    /// Keychain account name.
    pub keyring_account: String,
}

impl NexusConfig {
    pub(crate) fn validate(&self) -> Result<()> {
        let issuer =
            url::Url::parse(&self.issuer).map_err(|e| Error::Config(format!("issuer: {e}")))?;
        if !matches!(issuer.scheme(), "http" | "https") {
            return Err(Error::Config("issuer must be http(s)".into()));
        }
        url::Url::parse(&self.redirect_uri)
            .map_err(|e| Error::Config(format!("redirect_uri: {e}")))?;
        if self.client_id.is_empty() {
            return Err(Error::Config("client_id is empty".into()));
        }
        Ok(())
    }

    pub(crate) fn base(&self) -> &str {
        self.issuer.trim_end_matches('/')
    }

    pub(crate) fn ws_url(&self) -> Result<String> {
        let u = url::Url::parse(&self.issuer).map_err(|e| Error::Config(e.to_string()))?;
        let scheme = if u.scheme() == "https" { "wss" } else { "ws" };
        let host = u
            .host_str()
            .ok_or_else(|| Error::Config("issuer has no host".into()))?;
        let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
        Ok(format!("{scheme}://{host}{port}/ws/v1/user"))
    }
}
