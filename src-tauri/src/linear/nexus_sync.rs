use reqwest::header::{ETAG, IF_MATCH};
use reqwest::StatusCode;
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
        for _ in 0..3 {
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
            let existing_bundle: TokenBundle = serde_json::from_str(&response.secret)
                .map_err(|_| Error::LinearApi("Nexus Linear credentials are invalid".into()))?;
            let merged = merge_bundle(&existing_bundle, bundle);
            if merged == existing_bundle {
                return Ok(existing.id.clone());
            }
            let encoded = serde_json::to_string(&merged)
                .map_err(|error| Error::LinearApi(error.to_string()))?;
            let update = client
                .put(format!("{NEXUS}/credentials/{}/secret", existing.id))
                .bearer_auth(&bearer)
                .header(IF_MATCH, revision)
                .json(&ReplaceSecret { secret: &encoded })
                .send()
                .await
                .map_err(request_error)?;
            if update.status().is_success() {
                return Ok(existing.id.clone());
            }
            if update.status() != StatusCode::CONFLICT
                && update.status() != StatusCode::PRECONDITION_FAILED
            {
                return Err(request_error(
                    update.error_for_status().expect_err("non-success response"),
                ));
            }
        }
        return Err(Error::LinearApi(
            "Nexus credential changed repeatedly; retry to sync Linear and Codex links".into(),
        ));
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

fn merge_bundle(existing: &TokenBundle, incoming: &TokenBundle) -> TokenBundle {
    let mut merged = if incoming.expires_at >= existing.expires_at {
        incoming.clone()
    } else {
        existing.clone()
    };

    let mut links =
        std::collections::HashMap::<(String, String), super::oauth::LinearCodexLink>::new();
    for link in existing
        .codex_links
        .iter()
        .chain(incoming.codex_links.iter())
    {
        let key = (link.issue_id.clone(), link.device_id.clone());
        let replace = links
            .get(&key)
            .is_none_or(|current| link.updated_at >= current.updated_at);
        if replace {
            links.insert(key, link.clone());
        }
    }
    merged.codex_links = links.into_values().collect();
    merged.codex_links.sort_by(|left, right| {
        (&left.issue_id, &left.device_id).cmp(&(&right.issue_id, &right.device_id))
    });

    let mut policies =
        std::collections::HashMap::<String, super::oauth::LinearCodexProjectPolicy>::new();
    for policy in existing
        .codex_project_policy
        .iter()
        .chain(incoming.codex_project_policy.iter())
    {
        let replace = policies
            .get(&policy.project_id)
            .is_none_or(|current| policy.updated_at >= current.updated_at);
        if replace {
            policies.insert(policy.project_id.clone(), policy.clone());
        }
    }
    merged.codex_project_policy = policies.into_values().collect();
    merged
        .codex_project_policy
        .sort_by(|left, right| left.project_id.cmp(&right.project_id));
    merged
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linear::oauth::{LinearCodexLink, LinearCodexProjectPolicy};

    #[test]
    fn merge_keeps_other_devices_and_applies_the_newest_project_policy() {
        let existing = TokenBundle {
            access_token: "old-access".into(),
            refresh_token: "old-refresh".into(),
            expires_at: 10,
            codex_links: vec![LinearCodexLink {
                issue_id: "issue-1".into(),
                device_id: "device-a".into(),
                workspace_repo: "org/repo".into(),
                workspace_name: "repo".into(),
                thread_id: "thread-a".into(),
                updated_at: 4,
            }],
            codex_project_policy: vec![LinearCodexProjectPolicy {
                project_id: "project-1".into(),
                allowed: true,
                workspace_repo: Some("org/repo".into()),
                updated_at: 4,
            }],
        };
        let incoming = TokenBundle {
            access_token: "new-access".into(),
            refresh_token: "new-refresh".into(),
            expires_at: 20,
            codex_links: vec![LinearCodexLink {
                issue_id: "issue-1".into(),
                device_id: "device-b".into(),
                workspace_repo: "org/repo".into(),
                workspace_name: "repo".into(),
                thread_id: "thread-b".into(),
                updated_at: 8,
            }],
            codex_project_policy: vec![LinearCodexProjectPolicy {
                project_id: "project-1".into(),
                allowed: false,
                workspace_repo: Some("org/repo".into()),
                updated_at: 8,
            }],
        };

        let merged = merge_bundle(&existing, &incoming);
        assert_eq!(merged.access_token, "new-access");
        assert_eq!(merged.codex_links.len(), 2);
        assert!(!merged.codex_project_policy[0].allowed);
    }
}
