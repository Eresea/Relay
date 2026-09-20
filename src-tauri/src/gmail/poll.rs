//! Incremental inbox polling: turn a stored `historyId` plus one Gmail API
//! round trip into the small list of messages worth notifying about.
//!
//! The first poll after connecting has no `historyId` yet, so it only
//! establishes a baseline (`users.getProfile`) and notifies about nothing —
//! connecting a mailbox with years of mail should not replay all of it. Every
//! poll after that walks `users.history.list` forward from the last
//! checkpoint, which is what keeps a poll cheap regardless of inbox size:
//! Gmail's quota charges for what changed, not for a full mailbox scan.

use crate::error::{Error, Result};
use crate::gmail::api::{GoogleApi, MessageMeta};
use crate::gmail::rules::NotificationRules;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PollCheckpoint {
    pub last_history_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MailNotification {
    pub message_id: String,
    pub from: String,
    pub subject: String,
}

impl From<&MessageMeta> for MailNotification {
    fn from(message: &MessageMeta) -> Self {
        Self {
            message_id: message.id.clone(),
            from: message.from.clone(),
            subject: message.subject.clone(),
        }
    }
}

/// Runs one poll cycle against `checkpoint`, advancing it in place, and
/// returns the notifications that should fire. `client` and `access_token`
/// are provided by the caller rather than looked up here, so this stays a
/// plain async function testable with `fakes::FakeGoogleApi` and no Tauri
/// state at all.
pub async fn poll_once(
    client: &impl GoogleApi,
    access_token: &str,
    checkpoint: &mut PollCheckpoint,
    rules: &NotificationRules,
) -> Result<Vec<MailNotification>> {
    let Some(start_history_id) = checkpoint.last_history_id.clone() else {
        let profile = client.get_profile(access_token).await?;
        checkpoint.last_history_id = Some(profile.history_id);
        return Ok(Vec::new());
    };

    let message_ids = match collect_new_message_ids(client, access_token, &start_history_id).await {
        Ok(collected) => collected,
        Err(Error::GmailHistoryExpired) => {
            // The checkpoint fell out of Gmail's retained history window
            // (about a week). There is no way to know what was missed, so
            // re-baseline silently rather than guessing — the same as a
            // fresh connection.
            let profile = client.get_profile(access_token).await?;
            checkpoint.last_history_id = Some(profile.history_id);
            return Ok(Vec::new());
        }
        Err(other) => return Err(other),
    };

    checkpoint.last_history_id = Some(message_ids.newest_history_id);

    let mut notifications = Vec::new();
    for id in message_ids.ids {
        let message = client.get_message_metadata(access_token, &id).await?;
        if rules.matches(&message) {
            notifications.push(MailNotification::from(&message));
        }
    }
    Ok(notifications)
}

struct CollectedMessages {
    ids: Vec<String>,
    newest_history_id: String,
}

/// Pages through `history.list` until it runs out of pages, deduplicating —
/// the same message can legitimately appear in more than one history record
/// (e.g. added and then labelled) within one poll window.
async fn collect_new_message_ids(
    client: &impl GoogleApi,
    access_token: &str,
    start_history_id: &str,
) -> Result<CollectedMessages> {
    let mut ids = Vec::new();
    let mut newest_history_id = start_history_id.to_string();
    let mut page_token = None;

    loop {
        let page = client
            .list_history(access_token, start_history_id, page_token.as_deref())
            .await?;
        ids.extend(page.added_message_ids);
        if let Some(history_id) = page.history_id {
            newest_history_id = history_id;
        }
        page_token = page.next_page_token;
        if page_token.is_none() {
            break;
        }
    }

    ids.sort();
    ids.dedup();
    Ok(CollectedMessages {
        ids,
        newest_history_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::api::fakes::FakeGoogleApi;
    use crate::gmail::api::{HistoryPage, Profile};
    use crate::gmail::rules::{Rule, RuleKind};

    fn message(id: &str, label_ids: &[&str], from: &str, subject: &str) -> MessageMeta {
        MessageMeta {
            id: id.into(),
            label_ids: label_ids.iter().map(|s| s.to_string()).collect(),
            from: from.into(),
            subject: subject.into(),
        }
    }

    #[tokio::test]
    async fn first_poll_establishes_a_baseline_and_notifies_nothing() {
        let client = FakeGoogleApi::default();
        *client.profile.lock().unwrap() = Some(Profile {
            email_address: "me@example.com".into(),
            history_id: "1000".into(),
        });

        let mut checkpoint = PollCheckpoint::default();
        let notifications = poll_once(
            &client,
            "token",
            &mut checkpoint,
            &NotificationRules::default(),
        )
        .await
        .unwrap();

        assert!(notifications.is_empty());
        assert_eq!(checkpoint.last_history_id, Some("1000".into()));
        assert!(client.history_calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn subsequent_poll_notifies_only_matching_new_messages() {
        let client = FakeGoogleApi::default();
        client.history_pages.lock().unwrap().push(Ok(HistoryPage {
            added_message_ids: vec!["m1".into(), "m2".into()],
            history_id: Some("1010".into()),
            next_page_token: None,
        }));
        client.messages.lock().unwrap().insert(
            "m1".into(),
            message("m1", &["INBOX", "IMPORTANT"], "boss@work.com", "Q3 plan"),
        );
        client.messages.lock().unwrap().insert(
            "m2".into(),
            message("m2", &["INBOX"], "newsletter@spam.com", "50% off"),
        );

        let mut checkpoint = PollCheckpoint {
            last_history_id: Some("1000".into()),
        };
        let notifications = poll_once(
            &client,
            "token",
            &mut checkpoint,
            &NotificationRules::default(),
        )
        .await
        .unwrap();

        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].message_id, "m1");
        assert_eq!(checkpoint.last_history_id, Some("1010".into()));
        assert_eq!(
            client.history_calls.lock().unwrap()[0],
            ("1000".to_string(), None)
        );
    }

    #[tokio::test]
    async fn pagination_collects_messages_across_every_page() {
        let client = FakeGoogleApi::default();
        client.history_pages.lock().unwrap().push(Ok(HistoryPage {
            added_message_ids: vec!["m1".into()],
            history_id: None,
            next_page_token: Some("page-2".into()),
        }));
        client.history_pages.lock().unwrap().push(Ok(HistoryPage {
            added_message_ids: vec!["m2".into()],
            history_id: Some("1020".into()),
            next_page_token: None,
        }));
        for id in ["m1", "m2"] {
            client.messages.lock().unwrap().insert(
                id.into(),
                message(id, &["INBOX", "IMPORTANT"], "a@b.com", "hi"),
            );
        }

        let mut checkpoint = PollCheckpoint {
            last_history_id: Some("1000".into()),
        };
        let notifications = poll_once(
            &client,
            "token",
            &mut checkpoint,
            &NotificationRules::default(),
        )
        .await
        .unwrap();

        assert_eq!(notifications.len(), 2);
        assert_eq!(checkpoint.last_history_id, Some("1020".into()));
        let calls = client.history_calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].1, Some("page-2".to_string()));
    }

    #[tokio::test]
    async fn expired_history_id_reestablishes_a_baseline_without_notifying() {
        let client = FakeGoogleApi::default();
        client
            .history_pages
            .lock()
            .unwrap()
            .push(Err(Error::GmailHistoryExpired));
        *client.profile.lock().unwrap() = Some(Profile {
            email_address: "me@example.com".into(),
            history_id: "2000".into(),
        });

        let mut checkpoint = PollCheckpoint {
            last_history_id: Some("1".into()),
        };
        let notifications = poll_once(
            &client,
            "token",
            &mut checkpoint,
            &NotificationRules::default(),
        )
        .await
        .unwrap();

        assert!(notifications.is_empty());
        assert_eq!(checkpoint.last_history_id, Some("2000".into()));
    }

    #[tokio::test]
    async fn duplicate_message_ids_across_pages_notify_once() {
        let client = FakeGoogleApi::default();
        client.history_pages.lock().unwrap().push(Ok(HistoryPage {
            added_message_ids: vec!["m1".into(), "m1".into()],
            history_id: Some("1010".into()),
            next_page_token: None,
        }));
        client.messages.lock().unwrap().insert(
            "m1".into(),
            message("m1", &["INBOX", "IMPORTANT"], "a@b.com", "hi"),
        );

        let mut checkpoint = PollCheckpoint {
            last_history_id: Some("1000".into()),
        };
        let notifications = poll_once(
            &client,
            "token",
            &mut checkpoint,
            &NotificationRules::default(),
        )
        .await
        .unwrap();

        assert_eq!(notifications.len(), 1);
    }

    #[tokio::test]
    async fn custom_rule_can_match_alongside_important_label() {
        let client = FakeGoogleApi::default();
        client.history_pages.lock().unwrap().push(Ok(HistoryPage {
            added_message_ids: vec!["m1".into()],
            history_id: Some("1010".into()),
            next_page_token: None,
        }));
        client.messages.lock().unwrap().insert(
            "m1".into(),
            message("m1", &["INBOX"], "alerts@ci.example.com", "Build failed"),
        );

        let rules = NotificationRules {
            notify_all: false,
            notify_important: false,
            custom: vec![Rule {
                id: "r1".into(),
                enabled: true,
                kind: RuleKind::FromContains {
                    text: "ci.example.com".into(),
                },
            }],
        };
        let mut checkpoint = PollCheckpoint {
            last_history_id: Some("1000".into()),
        };
        let notifications = poll_once(&client, "token", &mut checkpoint, &rules)
            .await
            .unwrap();

        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].subject, "Build failed");
    }
}
