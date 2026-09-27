use reqwest::header::{ETAG, IF_MATCH};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::error::{Error, Result};
use crate::nexus_auth;

use super::{oauth::TokenBundle, LinearConnection};

const NEXUS: &str = "https://nexus.eresea.net/api/v1";
const CLIENT_ID: &str = "relay";

#[derive(Deserialize)]
struct CredentialList {
    #[serde(default)]
    credentials: Vec<Credential>,
}

#[derive(Deserialize)]
struct Credential {
    id: String,
    namespace: String,
    #[serde(rename = "type")]
    credential_type: String,
    metadata: Value,
}

#[derive(Deserialize)]
struct CredentialCreated {
    id: String,
}

#[derive(Deserialize)]
struct SecretResponse {
    secret: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    organization_id: String,
    organization_name: String,
    url_key: String,
    viewer_id: String,
    viewer_name: String,
    viewer_email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateCredential<'a> {
    namespace: &'static str,
    #[serde(rename = "type")]
    credential_type: &'static str,
    label: String,
    metadata: &'a Metadata,
    secret: String,
}

#[derive(Serialize)]
struct ReplaceSecret<'a> {
    secret: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    can_read: bool,
    can_replace: bool,
}

pub async fn persist(
    app: &AppHandle,
    connection: &LinearConnection,
    bundle: &TokenBundle,
) -> Result<String> {
    let client = client()?;
    let bearer = nexus_auth::access_token(app)
        .await
        .map_err(|_| Error::LinearApi("sign in to Nexus to sync this Linear connection".into()))?;
    let credentials = granted(&client, &bearer).await?;
    let metadata = Metadata {
        organization_id: connection.organization_id.clone(),
        organization_name: connection.organization_name.clone(),
        url_key: connection.url_key.clone(),
        viewer_id: connection.viewer_id.clone(),
        viewer_name: connection.viewer_name.clone(),
        viewer_email: connection.viewer_email.clone(),
    };
    let encoded =
        serde_json::to_string(bundle).map_err(|error| Error::LinearApi(error.to_string()))?;
    if let Some(existing) = credentials.iter().find(|credential| {
        credential.namespace == "linear"
            && credential.credential_type == "oauth-token-bundle"
            && credential.metadata["organizationId"] == connection.organization_id
    }) {
        let response = client
            .get(format!("{NEXUS}/credentials/{}/secret", existing.id))
            .bearer_auth(&bearer)
            .send()
            .await
            .map_err(request_error)?
            .error_for_status()
            .map_err(request_error)?;
        let revision = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| Error::LinearApi("Nexus returned no credential revision".into()))?
            .to_owned();
        let response: SecretResponse = response.json().await.map_err(request_error)?;
        if serde_json::from_str::<TokenBundle>(&response.secret)
            .ok()
            .as_ref()
            == Some(bundle)
        {
            return Ok(existing.id.clone());
        }
        client
            .put(format!("{NEXUS}/credentials/{}/secret", existing.id))
            .bearer_auth(&bearer)
            .header(IF_MATCH, revision)
            .json(&ReplaceSecret { secret: &encoded })
            .send()
            .await
            .map_err(request_error)?
            .error_for_status()
            .map_err(request_error)?;
        return Ok(existing.id.clone());
    }

    let created: CredentialCreated = client
        .post(format!("{NEXUS}/credentials"))
        .bearer_auth(&bearer)
        .json(&CreateCredential {
            namespace: "linear",
            credential_type: "oauth-token-bundle",
            label: format!("Linear — {}", connection.organization_name),
            metadata: &metadata,
            secret: encoded,
        })
        .send()
        .await
        .map_err(request_error)?
        .error_for_status()
        .map_err(request_error)?
        .json()
        .await
        .map_err(request_error)?;
    client
        .put(format!(
            "{NEXUS}/credentials/{}/grants/{CLIENT_ID}",
            created.id
        ))
        .bearer_auth(&bearer)
        .json(&Grant {
            can_read: true,
            can_replace: true,
        })
        .send()
        .await
        .map_err(request_error)?
        .error_for_status()
        .map_err(request_error)?;
    Ok(created.id)
}

pub async fn discover(app: &AppHandle) -> Result<Vec<(String, LinearConnection, TokenBundle)>> {
    let client = client()?;
    let bearer = nexus_auth::access_token(app)
        .await
        .map_err(|_| Error::LinearApi("Nexus is not connected".into()))?;
    let credentials = granted(&client, &bearer).await?;
    let mut connections = Vec::new();
    for credential in credentials.into_iter().filter(|credential| {
        credential.namespace == "linear" && credential.credential_type == "oauth-token-bundle"
    }) {
        let metadata: Metadata = serde_json::from_value(credential.metadata)
            .map_err(|_| Error::LinearApi("Nexus Linear metadata is invalid".into()))?;
        let secret: SecretResponse = client
            .get(format!("{NEXUS}/credentials/{}/secret", credential.id))
            .bearer_auth(&bearer)
            .send()
            .await
            .map_err(request_error)?
            .error_for_status()
            .map_err(request_error)?
            .json()
            .await
            .map_err(request_error)?;
        let bundle = serde_json::from_str(&secret.secret)
            .map_err(|_| Error::LinearApi("Nexus Linear credentials are invalid".into()))?;
        connections.push((
            credential.id,
            LinearConnection {
                organization_id: metadata.organization_id,
                organization_name: metadata.organization_name,
                url_key: metadata.url_key,
                viewer_id: metadata.viewer_id,
                viewer_name: metadata.viewer_name,
                viewer_email: metadata.viewer_email,
                nexus_credential_id: None,
            },
            bundle,
        ));
    }
    Ok(connections)
}

pub async fn revoke(app: &AppHandle, organization_id: &str) -> Result<()> {
    let client = client()?;
    let bearer = nexus_auth::access_token(app)
        .await
        .map_err(|_| Error::LinearApi("Nexus is not connected".into()))?;
    for credential in granted(&client, &bearer)
        .await?
        .into_iter()
        .filter(|credential| {
            credential.namespace == "linear"
                && credential.credential_type == "oauth-token-bundle"
                && credential.metadata["organizationId"] == organization_id
        })
    {
        client
            .delete(format!(
                "{NEXUS}/credentials/{}/grants/{CLIENT_ID}",
                credential.id
            ))
            .bearer_auth(&bearer)
            .send()
            .await
            .map_err(request_error)?
            .error_for_status()
            .map_err(request_error)?;
    }
    Ok(())
}

async fn granted(client: &reqwest::Client, bearer: &str) -> Result<Vec<Credential>> {
    let response: CredentialList = client
        .get(format!("{NEXUS}/credentials/granted"))
        .bearer_auth(bearer)
        .send()
        .await
        .map_err(request_error)?
        .error_for_status()
        .map_err(request_error)?
        .json()
        .await
        .map_err(request_error)?;
    Ok(response.credentials)
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| Error::LinearApi(error.to_string()))
}

fn request_error(error: reqwest::Error) -> Error {
    let status = error.status();
    if status.is_some_and(|status| status.as_u16() == 403) {
        return Error::LinearApi(
            "Nexus denied credential sharing; reconnect Nexus to approve Relay’s Linear sync permission".into(),
        );
    }
    Error::LinearApi(format!(
        "Nexus credential request failed{}",
        status.map_or(String::new(), |status| format!(" with HTTP {status}"))
    ))
}
