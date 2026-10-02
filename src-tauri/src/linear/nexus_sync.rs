//! Linear token bundles as `linear` connections in the signed-in Nexus
//! account (SDK `connections()`), the same way GitHub is stored. Relay creates
//! them, so Nexus grants them to Relay automatically and every Relay
//! installation of the account discovers them with `granted()`.

use nexus_client::{CredentialInput, Error as NexusError, NexusClient};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

use crate::error::{Error, Result};
use crate::nexus_auth;

use super::{oauth::TokenBundle, LinearConnection};

const NAMESPACE: &str = "linear";
const CREDENTIAL_TYPE: &str = "oauth-token-bundle";
const REPLACE_ATTEMPTS: usize = 3;

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

pub async fn persist(
    app: &AppHandle,
    connection: &LinearConnection,
    bundle: &TokenBundle,
) -> Result<String> {
    let client = signed_in(app, "sign in to Nexus to sync this Linear connection")?;
    let connections = client.connections();
    let credentials = connections.granted().await.map_err(request_error)?;
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
        credential.revoked_at.is_none()
            && credential.namespace == NAMESPACE
            && credential.credential_type == CREDENTIAL_TYPE
            && credential.metadata["organizationId"] == connection.organization_id
    }) {
        // Conditional replace: when another installation wrote in between
        // (`credential_revision_conflict`) re-read, merge and retry.
        for _ in 0..REPLACE_ATTEMPTS {
            let current = connections
                .read_secret(&existing.id)
                .await
                .map_err(request_error)?;
            let existing_bundle: TokenBundle = serde_json::from_str(&current.secret)
                .map_err(|_| Error::LinearApi("Nexus Linear credentials are invalid".into()))?;
            let merged = merge_bundle(&existing_bundle, bundle);
            if merged == existing_bundle {
                return Ok(existing.id.clone());
            }
            let encoded = serde_json::to_string(&merged)
                .map_err(|error| Error::LinearApi(error.to_string()))?;
            match connections
                .replace_secret(&existing.id, &encoded, None, current.revision.as_deref())
                .await
            {
                Ok(_) => return Ok(existing.id.clone()),
                Err(error) if error.is_revision_conflict() => {}
                Err(error) => return Err(request_error(error)),
            }
        }
        return Err(Error::LinearApi(
            "Nexus credential changed repeatedly; retry to sync Linear and Codex links".into(),
        ));
    }

    let created = connections
        .create(&CredentialInput {
            namespace: NAMESPACE.into(),
            credential_type: CREDENTIAL_TYPE.into(),
            label: format!("Linear — {}", connection.organization_name),
            metadata: json!(metadata),
            secret: encoded,
            expires_at: None,
        })
        .await
        .map_err(request_error)?;
    Ok(created.id)
}

pub(super) fn merge_bundle(existing: &TokenBundle, incoming: &TokenBundle) -> TokenBundle {
    let mut merged = if incoming.expires_at >= existing.expires_at {
        incoming.clone()
    } else {
        existing.clone()
    };
    merged.agent = match (&existing.agent, &incoming.agent) {
        (Some(left), Some(right)) => Some(if right.expires_at >= left.expires_at {
            right.clone()
        } else {
            left.clone()
        }),
        (Some(agent), None) | (None, Some(agent)) => Some(agent.clone()),
        (None, None) => None,
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

pub(super) fn current_bundle_for(
    connections: Vec<(String, LinearConnection, TokenBundle)>,
    organization_id: &str,
    now: u64,
) -> Option<TokenBundle> {
    connections.into_iter().find_map(|(_, connection, bundle)| {
        (connection.organization_id == organization_id && bundle.expires_at > now + 60)
            .then_some(bundle)
    })
}

pub async fn discover(app: &AppHandle) -> Result<Vec<(String, LinearConnection, TokenBundle)>> {
    let client = signed_in(app, "Nexus is not connected")?;
    let connections_api = client.connections();
    let credentials = connections_api.granted().await.map_err(request_error)?;
    let mut connections = Vec::new();
    for credential in credentials.into_iter().filter(|credential| {
        credential.revoked_at.is_none()
            && credential.namespace == NAMESPACE
            && credential.credential_type == CREDENTIAL_TYPE
    }) {
        let metadata: Metadata = serde_json::from_value(credential.metadata)
            .map_err(|_| Error::LinearApi("Nexus Linear metadata is invalid".into()))?;
        let secret = connections_api
            .read_secret(&credential.id)
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
                agent_installed: false,
                paused_on_device: false,
                nexus_sync_pending: false,
            },
            bundle,
        ));
    }
    Ok(connections)
}

fn signed_in(app: &AppHandle, signed_out: &str) -> Result<NexusClient> {
    nexus_auth::signed_in_client(app).map_err(|_| Error::LinearApi(signed_out.into()))
}

fn request_error(error: NexusError) -> Error {
    match error {
        NexusError::Api { status: 403, .. } => Error::LinearApi(
            "Nexus denied access to connections; sign out and sign in again to approve Relay’s permission".into(),
        ),
        NexusError::Api { status, .. } => {
            Error::LinearApi(format!("Nexus credential request failed with HTTP {status}"))
        }
        other if other.is_signed_out() => Error::LinearApi("Nexus is not connected".into()),
        _ => Error::LinearApi("Nexus credential request failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linear::oauth::{AgentTokenBundle, LinearCodexLink, LinearCodexProjectPolicy};

    #[test]
    fn current_bundle_for_uses_only_a_fresh_matching_workspace_credential() {
        let connection = |organization_id: &str| LinearConnection {
            organization_id: organization_id.into(),
            organization_name: organization_id.into(),
            url_key: organization_id.into(),
            viewer_id: "viewer".into(),
            viewer_name: "Viewer".into(),
            viewer_email: "viewer@example.com".into(),
            nexus_credential_id: None,
            agent_installed: false,
            paused_on_device: false,
            nexus_sync_pending: false,
        };
        let bundle = |expires_at| TokenBundle {
            access_token: "fresh".into(),
            refresh_token: "refresh".into(),
            expires_at,
            agent: None,
            codex_links: vec![],
            codex_project_policy: vec![],
        };
        let connections = vec![
            ("other-credential".into(), connection("other"), bundle(500)),
            (
                "expired-credential".into(),
                connection("target"),
                bundle(100),
            ),
            (
                "current-credential".into(),
                connection("target"),
                bundle(500),
            ),
        ];

        assert_eq!(
            current_bundle_for(connections, "target", 200).map(|bundle| bundle.expires_at),
            Some(500)
        );
        assert!(current_bundle_for(vec![], "target", 200).is_none());
    }

    #[test]
    fn merge_keeps_other_devices_and_applies_the_newest_project_policy() {
        let existing = TokenBundle {
            access_token: "old-access".into(),
            refresh_token: "old-refresh".into(),
            expires_at: 10,
            agent: Some(AgentTokenBundle {
                access_token: "old-agent".into(),
                refresh_token: "old-agent-refresh".into(),
                expires_at: 30,
            }),
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
            agent: Some(AgentTokenBundle {
                access_token: "new-agent".into(),
                refresh_token: "new-agent-refresh".into(),
                expires_at: 40,
            }),
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
        assert_eq!(merged.agent.unwrap().access_token, "new-agent");
        assert_eq!(merged.codex_links.len(), 2);
        assert!(!merged.codex_project_policy[0].allowed);
    }

    #[test]
    fn merge_preserves_a_locally_installed_agent_when_nexus_is_stale() {
        let local = TokenBundle {
            access_token: "local-access".into(),
            refresh_token: "local-refresh".into(),
            expires_at: 20,
            agent: Some(AgentTokenBundle {
                access_token: "agent-access".into(),
                refresh_token: "agent-refresh".into(),
                expires_at: 40,
            }),
            codex_links: vec![LinearCodexLink {
                issue_id: "issue-1".into(),
                device_id: "device-a".into(),
                workspace_repo: "org/repo".into(),
                workspace_name: "repo".into(),
                thread_id: "thread-1".into(),
                updated_at: 4,
            }],
            codex_project_policy: vec![],
        };
        let nexus = TokenBundle {
            access_token: "remote-access".into(),
            refresh_token: "remote-refresh".into(),
            expires_at: 30,
            agent: None,
            codex_links: vec![],
            codex_project_policy: vec![],
        };

        let merged = merge_bundle(&local, &nexus);
        assert_eq!(merged.access_token, "remote-access");
        assert_eq!(merged.agent.unwrap().access_token, "agent-access");
        assert_eq!(merged.codex_links.len(), 1);
    }
}
