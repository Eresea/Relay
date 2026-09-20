//! Deciding which new messages are worth a notification.
//!
//! Kept flat and independently enable-able on purpose — Gmail has no
//! directory structure the way a GitHub repo does, so there is no per-branch
//! matrix to build here. Gmail's own `IMPORTANT` label (its priority-inbox
//! signal) is the default definition of "important"; a user can broaden that
//! to every new message, or add sender/subject rules of their own.

use serde::{Deserialize, Serialize};

use crate::gmail::api::MessageMeta;

pub const IMPORTANT_LABEL: &str = "IMPORTANT";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RuleKind {
    /// Case-insensitive substring match against the `From` header.
    FromContains { text: String },
    /// Case-insensitive substring match against the `Subject` header.
    SubjectContains { text: String },
    /// Exact match against one of the message's Gmail label ids (e.g. `STARRED`).
    Label { label: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    pub enabled: bool,
    #[serde(flatten)]
    pub kind: RuleKind,
}

impl Rule {
    fn matches(&self, message: &MessageMeta) -> bool {
        if !self.enabled {
            return false;
        }
        match &self.kind {
            RuleKind::FromContains { text } => contains_ignore_case(&message.from, text),
            RuleKind::SubjectContains { text } => contains_ignore_case(&message.subject, text),
            RuleKind::Label { label } => message.label_ids.iter().any(|id| id == label),
        }
    }
}

fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    !needle.is_empty() && haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// The connector's whole notification policy. `notify_all` and
/// `notify_important` are independent toggles rather than a priority list —
/// either one alone is enough to fire, and so is any enabled custom rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRules {
    pub notify_all: bool,
    pub notify_important: bool,
    #[serde(default)]
    pub custom: Vec<Rule>,
}

impl Default for NotificationRules {
    fn default() -> Self {
        Self {
            notify_all: false,
            notify_important: true,
            custom: Vec::new(),
        }
    }
}

impl NotificationRules {
    pub fn matches(&self, message: &MessageMeta) -> bool {
        if self.notify_all {
            return true;
        }
        if self.notify_important && message.label_ids.iter().any(|id| id == IMPORTANT_LABEL) {
            return true;
        }
        self.custom.iter().any(|rule| rule.matches(message))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(label_ids: &[&str], from: &str, subject: &str) -> MessageMeta {
        MessageMeta {
            id: "msg-1".into(),
            label_ids: label_ids.iter().map(|s| s.to_string()).collect(),
            from: from.into(),
            subject: subject.into(),
        }
    }

    #[test]
    fn default_rules_fire_only_on_the_important_label() {
        let rules = NotificationRules::default();
        assert!(rules.matches(&message(&["INBOX", "IMPORTANT"], "a@b.com", "hi")));
        assert!(!rules.matches(&message(&["INBOX"], "a@b.com", "hi")));
    }

    #[test]
    fn notify_all_overrides_everything() {
        let rules = NotificationRules {
            notify_all: true,
            notify_important: false,
            custom: Vec::new(),
        };
        assert!(rules.matches(&message(&["INBOX"], "a@b.com", "hi")));
    }

    #[test]
    fn disabled_custom_rule_never_matches() {
        let rules = NotificationRules {
            notify_all: false,
            notify_important: false,
            custom: vec![Rule {
                id: "r1".into(),
                enabled: false,
                kind: RuleKind::FromContains {
                    text: "boss@work.com".into(),
                },
            }],
        };
        assert!(!rules.matches(&message(&["INBOX"], "boss@work.com", "hi")));
    }

    #[test]
    fn from_contains_is_case_insensitive() {
        let rules = NotificationRules {
            notify_all: false,
            notify_important: false,
            custom: vec![Rule {
                id: "r1".into(),
                enabled: true,
                kind: RuleKind::FromContains {
                    text: "Boss@Work.com".into(),
                },
            }],
        };
        assert!(rules.matches(&message(&["INBOX"], "boss@work.com", "hi")));
        assert!(!rules.matches(&message(&["INBOX"], "someone-else@work.com", "hi")));
    }

    #[test]
    fn subject_contains_matches_substrings() {
        let rules = NotificationRules {
            notify_all: false,
            notify_important: false,
            custom: vec![Rule {
                id: "r1".into(),
                enabled: true,
                kind: RuleKind::SubjectContains {
                    text: "invoice".into(),
                },
            }],
        };
        assert!(rules.matches(&message(&["INBOX"], "a@b.com", "Your March Invoice")));
        assert!(!rules.matches(&message(&["INBOX"], "a@b.com", "Lunch?")));
    }

    #[test]
    fn label_rule_matches_exact_label_id() {
        let rules = NotificationRules {
            notify_all: false,
            notify_important: false,
            custom: vec![Rule {
                id: "r1".into(),
                enabled: true,
                kind: RuleKind::Label {
                    label: "STARRED".into(),
                },
            }],
        };
        assert!(rules.matches(&message(&["INBOX", "STARRED"], "a@b.com", "hi")));
        assert!(!rules.matches(&message(&["INBOX"], "a@b.com", "hi")));
    }

    #[test]
    fn empty_substring_rule_never_matches_by_accident() {
        let rules = NotificationRules {
            notify_all: false,
            notify_important: false,
            custom: vec![Rule {
                id: "r1".into(),
                enabled: true,
                kind: RuleKind::FromContains { text: "".into() },
            }],
        };
        assert!(!rules.matches(&message(&["INBOX"], "anyone@anywhere.com", "hi")));
    }
}
