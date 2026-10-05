use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::header::{ETAG, IF_MATCH};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::client::{ensure_ok, json_ok, null_as_empty, NexusClient};
use crate::error::{BoxError, Error, Result};

/// RFC 3986 unreserved characters stay literal (ids contain `_`, and the server router matches raw paths).
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

fn seg(s: &str) -> String {
    utf8_percent_encode(s, SEGMENT).to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub namespace: String,
    #[serde(rename = "type")]
    pub credential_type: String,
    pub label: String,
    #[serde(default)]
    pub metadata: Value,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub created_by_client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub namespace: String,
    #[serde(rename = "type")]
    pub credential_type: String,
    pub label: String,
    pub metadata: Value,
    pub secret: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

/// A connection the user owns that this app may ask for (metadata only, never the secret).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableCredential {
    pub id: String,
    pub namespace: String,
    #[serde(rename = "type")]
    pub credential_type: String,
    pub label: String,
    pub created_by: Option<Creator>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Creator {
    pub client_id: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct Secret {
    pub credential_id: String,
    pub secret: String,
    pub expires_at: Option<String>,
    /// The `ETag`; pass it to [`Connections::replace_secret`] as `if_match`.
    pub revision: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantRequest {
    pub request_id: String,
    pub consent_url: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
#[serde(bound(deserialize = "T: Deserialize<'de>"))]
struct CredentialList<T> {
    #[serde(default = "Vec::new", deserialize_with = "null_as_empty")]
    credentials: Vec<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretBody {
    credential_id: String,
    secret: String,
    expires_at: Option<String>,
}

/// Needs the `connections` scope. Connections are account-level: this app can read/replace what it
/// created (auto-granted); for others it requests a grant the user approves.
#[derive(Clone)]
pub struct Connections {
    pub(crate) client: NexusClient,
}

impl Connections {
    pub async fn create(&self, input: &CredentialInput) -> Result<Credential> {
        let r = self
            .client
            .authed(Method::POST, "/credentials", |r| r.json(input))
            .await?;
        json_ok(r).await
    }

    /// Credentials granted to this app.
    pub async fn granted(&self) -> Result<Vec<Credential>> {
        let r = self
            .client
            .authed(Method::GET, "/credentials/granted", |r| r)
            .await?;
        Ok(json_ok::<CredentialList<Credential>>(r).await?.credentials)
    }

    /// The user's connections of `credential_type` (e.g. `"github"`) that this app is not granted yet.
    pub async fn available(&self, credential_type: &str) -> Result<Vec<AvailableCredential>> {
        let r = self
            .client
            .authed(Method::GET, "/credentials/available", |r| {
                r.query(&[("type", credential_type)])
            })
            .await?;
        Ok(json_ok::<CredentialList<AvailableCredential>>(r)
            .await?
            .credentials)
    }

    pub async fn read_secret(&self, id: &str) -> Result<Secret> {
        let path = format!("/credentials/{}/secret", seg(id));
        let r = ensure_ok(self.client.authed(Method::GET, &path, |r| r).await?).await?;
        let revision = r
            .headers()
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let b: SecretBody = r.json().await?;
        Ok(Secret {
            credential_id: b.credential_id,
            secret: b.secret,
            expires_at: b.expires_at,
            revision,
        })
    }

    /// With `if_match` (a [`Secret::revision`]) the write is conditional; if the secret changed
    /// meanwhile this fails with [`Error::RevisionConflict`]: re-read and retry. Returns the new revision.
    pub async fn replace_secret(
        &self,
        id: &str,
        secret: &str,
        expires_at: Option<&str>,
        if_match: Option<&str>,
    ) -> Result<Option<String>> {
        let path = format!("/credentials/{}/secret", seg(id));
        let body = json!({ "secret": secret, "expiresAt": expires_at });
        let r = self
            .client
            .authed(Method::PUT, &path, |r| {
                let r = r.json(&body);
                match if_match {
                    Some(v) => r.header(IF_MATCH, v),
                    None => r,
                }
            })
            .await?;
        let r = ensure_ok(r).await?;
        Ok(r.headers()
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string))
    }

    /// Deletes a connection this app created, for every device and app. Connections created by
    /// other apps are refused with [`Error::Api`] `404`; the user removes those on the Nexus
    /// account page.
    pub async fn delete(&self, id: &str) -> Result<()> {
        let path = format!("/credentials/{}", seg(id));
        ensure_ok(self.client.authed(Method::DELETE, &path, |r| r).await?).await?;
        Ok(())
    }

    /// Asks the user for access to a connection another app created. `opener` receives the consent
    /// URL (open it in the system browser). Poll [`Connections::granted`] afterwards.
    pub async fn request_grant<F>(
        &self,
        id: &str,
        can_replace: bool,
        opener: F,
    ) -> Result<GrantRequest>
    where
        F: FnOnce(&str) -> std::result::Result<(), BoxError>,
    {
        let path = format!("/credentials/{}/grant-requests", seg(id));
        let body = json!({ "canReplace": can_replace });
        let r = self
            .client
            .authed(Method::POST, &path, |r| r.json(&body))
            .await?;
        let req: GrantRequest = json_ok(r).await?;
        opener(&req.consent_url).map_err(|e| Error::Opener(e.to_string()))?;
        Ok(req)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEndpoint {
    pub id: String,
    pub client_id: String,
    pub signature_mode: String,
    #[serde(default)]
    pub signature_header: Option<String>,
    #[serde(default)]
    pub delivery_id_header: Option<String>,
    #[serde(default)]
    pub event_type_header: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEndpointInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature_header: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_id_header: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_type_header: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointSecret {
    pub endpoint_id: String,
    pub signing_secret: String,
}

#[derive(Clone)]
pub struct EventEndpoints {
    pub(crate) client: NexusClient,
}

impl EventEndpoints {
    /// The signing secret is shown once.
    pub async fn create(&self, input: &EventEndpointInput) -> Result<EndpointSecret> {
        let r = self
            .client
            .authed(Method::POST, "/events/endpoints", |r| r.json(input))
            .await?;
        json_ok(r).await
    }

    pub async fn list(&self) -> Result<Vec<EventEndpoint>> {
        #[derive(Deserialize)]
        struct L {
            #[serde(default = "Vec::new", deserialize_with = "null_as_empty")]
            endpoints: Vec<EventEndpoint>,
        }
        let r = self
            .client
            .authed(Method::GET, "/events/endpoints", |r| r)
            .await?;
        Ok(json_ok::<L>(r).await?.endpoints)
    }

    pub async fn revoke(&self, id: &str) -> Result<()> {
        let path = format!("/events/endpoints/{}", seg(id));
        let r = self.client.authed(Method::DELETE, &path, |r| r).await?;
        ensure_ok(r).await.map(|_| ())
    }
}

/// Push is centralised in Nexus; the device token is bound to the current session.
#[derive(Clone)]
pub struct Push {
    pub(crate) client: NexusClient,
}

impl Push {
    /// `platform` e.g. `"android"`, `"ios"`, `"desktop"`. `appId` is the configured client id.
    pub async fn register(
        &self,
        token: &str,
        platform: &str,
        label: Option<&str>,
    ) -> Result<Value> {
        let body = json!({
            "appId": self.client.config().client_id,
            "platform": platform,
            "token": token,
            "label": label,
        });
        let r = self
            .client
            .authed(Method::POST, "/notifications/devices", |r| r.json(&body))
            .await?;
        json_ok(r).await
    }

    pub async fn unregister(&self, token: &str) -> Result<()> {
        let body = json!({ "token": token });
        let r = self
            .client
            .authed(Method::DELETE, "/notifications/devices", |r| r.json(&body))
            .await?;
        ensure_ok(r).await.map(|_| ())
    }
}

impl NexusClient {
    pub fn connections(&self) -> Connections {
        Connections {
            client: self.clone(),
        }
    }

    pub fn event_endpoints(&self) -> EventEndpoints {
        EventEndpoints {
            client: self.clone(),
        }
    }

    pub fn push(&self) -> Push {
        Push {
            client: self.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::seg;

    #[test]
    fn segments_keep_unreserved_and_escape_the_rest() {
        assert_eq!(seg("cred_ab-1.x~"), "cred_ab-1.x~");
        assert_eq!(seg("a/b c"), "a%2Fb%20c");
    }
}
