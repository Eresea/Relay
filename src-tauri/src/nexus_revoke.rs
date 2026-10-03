//! Deleting the Nexus connection behind a disconnected connector for every
//! device. Apps may delete only connections they created; a disconnect that
//! cannot reach Nexus is remembered in a pending list and retried.

use nexus_client::{Credential, Error as NexusError, NexusClient};

use crate::nexus_auth::CLIENT_ID;

/// What to do about one remote connection after a disconnect.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// Relay created it: delete this credential id.
    Delete(String),
    /// Another app created it; Relay cannot delete it.
    OtherApp,
    /// Not in the account (any more): nothing to do.
    Absent,
}

/// How a removal attempt ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Removed,
    OtherApp,
    /// Offline, signed out or refused: keep it pending and try again later.
    Retry,
}

/// `found` is the credential's id and creating client, when it is in the account.
pub fn plan(found: Option<(&str, Option<&str>)>) -> Plan {
    match found {
        None => Plan::Absent,
        Some((id, creator)) if creator.is_none_or(|client| client == CLIENT_ID) => {
            Plan::Delete(id.to_owned())
        }
        Some(_) => Plan::OtherApp,
    }
}

/// A delete is settled when it succeeded or the connection is already gone (404).
pub fn delete_settled(result: &Result<(), NexusError>) -> bool {
    matches!(result, Ok(()) | Err(NexusError::Api { status: 404, .. }))
}

/// Adds `id` to the pending list once, or drops it when `done`.
pub fn update_pending(pending: &mut Vec<String>, id: &str, done: bool) {
    if done {
        pending.retain(|existing| existing != id);
    } else if !pending.iter().any(|existing| existing == id) {
        pending.push(id.to_owned());
    }
}

/// Plans and performs the removal of `found` (from `granted()`).
pub async fn remove(client: &NexusClient, found: Option<&Credential>) -> Outcome {
    let found = found.map(|credential| {
        (
            credential.id.as_str(),
            credential.created_by_client_id.as_deref(),
        )
    });
    match plan(found) {
        Plan::Absent => Outcome::Removed,
        Plan::OtherApp => Outcome::OtherApp,
        Plan::Delete(id) => {
            let result = client.connections().delete(&id).await;
            if delete_settled(&result) {
                Outcome::Removed
            } else {
                Outcome::Retry
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(status: u16) -> NexusError {
        NexusError::Api {
            status,
            code: String::new(),
            description: None,
        }
    }

    #[test]
    fn plan_deletes_only_connections_relay_created() {
        assert_eq!(plan(None), Plan::Absent);
        assert_eq!(plan(Some(("c1", Some("relay")))), Plan::Delete("c1".into()));
        assert_eq!(plan(Some(("c1", None))), Plan::Delete("c1".into()));
        assert_eq!(plan(Some(("c1", Some("other")))), Plan::OtherApp);
    }

    #[test]
    fn delete_is_settled_on_success_or_404_and_retried_otherwise() {
        assert!(delete_settled(&Ok(())));
        assert!(delete_settled(&Err(api(404))));
        assert!(!delete_settled(&Err(api(403))));
        assert!(!delete_settled(&Err(api(500))));
    }

    #[test]
    fn pending_entries_queue_once_and_clear_when_done() {
        let mut pending = Vec::new();
        update_pending(&mut pending, "a", false);
        update_pending(&mut pending, "a", false);
        update_pending(&mut pending, "b", false);
        assert_eq!(pending, vec!["a".to_owned(), "b".to_owned()]);
        update_pending(&mut pending, "a", true);
        assert_eq!(pending, vec!["b".to_owned()]);
    }
}
