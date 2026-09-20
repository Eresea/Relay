//! What the user wants to hear about, and what to leave alone.
//!
//! Not secret, so this lives in `settings.json` next to theme and autostart
//! (one JSON value under the key `github.settings`) rather than behind the
//! token store — both the frontend settings page and the Rust-side poll loop
//! read it from the same file, through `tauri_plugin_store`, so there is one
//! source of truth instead of two copies that can drift.
//!
//! Settings are organized per notification type rather than as a list of
//! freeform rules: one `NotificationTypeRule` per `PrEventKind`, each with
//! its own on/off switch and repo/branch scope. A list-of-rules model is
//! more expressive in principle, but nobody actually wants to compose
//! multiple overlapping rules to say "tell me about CI failures on
//! `my-org/*`" — they want one on/off switch per kind of event, scoped to
//! the repos and branches they care about, which is exactly what this shape
//! gives them for free from `should_notify`'s point of view: a direct lookup
//! by kind instead of a scan over a list.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrEventKind {
    Opened,
    Closed,
    Merged,
    ReviewRequested,
    CiFailed,
    CiPassed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTypeRule {
    pub enabled: bool,
    /// A glob against `"owner/repo"` — `"*"` for everything, `"my-org/*"`
    /// for one owner, or an exact `"my-org/my-repo"`.
    pub repo_pattern: String,
    /// Glob patterns; an empty list matches every branch. Checked against
    /// the pull request's base branch — the branch it targets, since that is
    /// what "notify me about changes to `main`" means to a reviewer.
    #[serde(default)]
    pub branch_include: Vec<String>,
    /// Glob patterns checked after `branch_include`; a match here excludes
    /// the branch even if `branch_include` matched it.
    #[serde(default)]
    pub branch_exclude: Vec<String>,
}

impl NotificationTypeRule {
    fn enabled(repo_pattern: &str) -> Self {
        Self {
            enabled: true,
            repo_pattern: repo_pattern.to_string(),
            branch_include: Vec::new(),
            branch_exclude: Vec::new(),
        }
    }

    fn disabled() -> Self {
        Self {
            enabled: false,
            repo_pattern: "*".to_string(),
            branch_include: Vec::new(),
            branch_exclude: Vec::new(),
        }
    }
}

fn default_poll_interval_secs() -> u64 {
    300
}

/// One `NotificationTypeRule` per `PrEventKind`, named fields rather than a
/// map — six known kinds, so a lookup is a `match`, not a runtime `HashMap`
/// access that needs a "missing key" fallback to reason about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    #[serde(default = "NotificationTypeRule::disabled")]
    pub opened: NotificationTypeRule,
    #[serde(default = "NotificationTypeRule::disabled")]
    pub closed: NotificationTypeRule,
    #[serde(default = "NotificationTypeRule::disabled")]
    pub merged: NotificationTypeRule,
    #[serde(default = "NotificationTypeRule::disabled")]
    pub review_requested: NotificationTypeRule,
    #[serde(default = "NotificationTypeRule::disabled")]
    pub ci_failed: NotificationTypeRule,
    #[serde(default = "NotificationTypeRule::disabled")]
    pub ci_passed: NotificationTypeRule,
}

impl NotificationSettings {
    pub fn rule_for(&self, kind: PrEventKind) -> &NotificationTypeRule {
        match kind {
            PrEventKind::Opened => &self.opened,
            PrEventKind::Closed => &self.closed,
            PrEventKind::Merged => &self.merged,
            PrEventKind::ReviewRequested => &self.review_requested,
            PrEventKind::CiFailed => &self.ci_failed,
            PrEventKind::CiPassed => &self.ci_passed,
        }
    }
}

impl Default for NotificationSettings {
    /// A fresh connection should not be silent, but it also should not spam:
    /// the statuses that call for a look (opened, merged, a review request,
    /// a red build) default on across every repo, and the one status that
    /// mostly confirms nothing is wrong (a green build) — and a plain
    /// "closed without merging", which is rarely actionable — default off.
    fn default() -> Self {
        Self {
            opened: NotificationTypeRule::enabled("*"),
            closed: NotificationTypeRule::disabled(),
            merged: NotificationTypeRule::enabled("*"),
            review_requested: NotificationTypeRule::enabled("*"),
            ci_failed: NotificationTypeRule::enabled("*"),
            ci_passed: NotificationTypeRule::disabled(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnectorSettings {
    #[serde(default = "default_poll_interval_secs")]
    pub poll_interval_secs: u64,
    #[serde(default)]
    pub notifications: NotificationSettings,
    /// Exact-match exceptions, checked before any rule — see `mute_keys`.
    #[serde(default)]
    pub muted: Vec<String>,
    /// The GitHub OAuth App (Device Flow enabled) to sign in with. Not a
    /// secret — device flow authenticates the app by this id alone, with no
    /// client secret involved — so it lives here rather than in the token
    /// store, and a user who wants to point Relay at their own OAuth App
    /// only ever has to paste an id, never rebuild anything. `None`/empty
    /// means connecting is not configured yet.
    #[serde(default)]
    pub client_id: Option<String>,
}

impl Default for GithubConnectorSettings {
    fn default() -> Self {
        Self {
            poll_interval_secs: default_poll_interval_secs(),
            notifications: NotificationSettings::default(),
            muted: Vec::new(),
            client_id: None,
        }
    }
}

/// A configured, non-blank client id, or `None` if connecting has not been
/// set up yet.
pub fn effective_client_id(settings: &GithubConnectorSettings) -> Option<&str> {
    settings
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

/// The minimum interval the poll loop will honor, regardless of what
/// settings.json says. GitHub's search API allows 30 authenticated
/// requests/minute; one poll cycle costs one search call plus one call per
/// changed pull request, so anything under a minute risks tripping the
/// secondary rate limit on an active account.
pub const MIN_POLL_INTERVAL_SECS: u64 = 60;

/// `"owner/repo"`, `"owner/repo@branch"`, and `"owner/repo#123"` — the three
/// granularities `settings.muted` can name. All three are checked for a
/// given pull request; muting any one of them silences it.
pub fn mute_keys(repo: &str, branch: &str, pr_number: u64) -> [String; 3] {
    [
        repo.to_string(),
        format!("{repo}@{branch}"),
        format!("{repo}#{pr_number}"),
    ]
}

fn is_muted(settings: &GithubConnectorSettings, repo: &str, branch: &str, pr_number: u64) -> bool {
    mute_keys(repo, branch, pr_number)
        .iter()
        .any(|key| settings.muted.iter().any(|m| m == key))
}

/// A small `*`-only glob, matching the whole string. `*` stands for any run
/// of characters, including none — good enough for `"owner/*"` and
/// `"release/*"` without pulling in a globbing crate for one wildcard.
pub fn glob_match(pattern: &str, value: &str) -> bool {
    fn matches(pattern: &[u8], value: &[u8]) -> bool {
        match pattern.split_first() {
            None => value.is_empty(),
            Some((b'*', rest)) => {
                matches(rest, value) || (!value.is_empty() && matches(pattern, &value[1..]))
            }
            Some((p, rest)) => !value.is_empty() && value[0] == *p && matches(rest, &value[1..]),
        }
    }
    matches(pattern.as_bytes(), value.as_bytes())
}

fn branch_matches(rule: &NotificationTypeRule, branch: &str) -> bool {
    let included =
        rule.branch_include.is_empty() || rule.branch_include.iter().any(|p| glob_match(p, branch));
    included && !rule.branch_exclude.iter().any(|p| glob_match(p, branch))
}

/// Whether `kind` on this pull request should reach the user, per their
/// settings and exceptions. Mutes always win; otherwise it is exactly the
/// rule for this one kind — enabled, and matching the repo and branch.
pub fn should_notify(
    settings: &GithubConnectorSettings,
    repo: &str,
    branch: &str,
    pr_number: u64,
    kind: PrEventKind,
) -> bool {
    if is_muted(settings, repo, branch, pr_number) {
        return false;
    }
    let rule = settings.notifications.rule_for(kind);
    rule.enabled && glob_match(&rule.repo_pattern, repo) && branch_matches(rule, branch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(
        notifications: NotificationSettings,
        muted: Vec<String>,
    ) -> GithubConnectorSettings {
        GithubConnectorSettings {
            poll_interval_secs: 300,
            notifications,
            muted,
            client_id: None,
        }
    }

    fn only(kind: PrEventKind, rule: NotificationTypeRule) -> NotificationSettings {
        let mut notifications = NotificationSettings {
            opened: NotificationTypeRule::disabled(),
            closed: NotificationTypeRule::disabled(),
            merged: NotificationTypeRule::disabled(),
            review_requested: NotificationTypeRule::disabled(),
            ci_failed: NotificationTypeRule::disabled(),
            ci_passed: NotificationTypeRule::disabled(),
        };
        match kind {
            PrEventKind::Opened => notifications.opened = rule,
            PrEventKind::Closed => notifications.closed = rule,
            PrEventKind::Merged => notifications.merged = rule,
            PrEventKind::ReviewRequested => notifications.review_requested = rule,
            PrEventKind::CiFailed => notifications.ci_failed = rule,
            PrEventKind::CiPassed => notifications.ci_passed = rule,
        }
        notifications
    }

    #[test]
    fn glob_star_matches_any_run_of_characters() {
        assert!(glob_match("*", "anything"));
        assert!(glob_match("my-org/*", "my-org/relay"));
        assert!(!glob_match("my-org/*", "other-org/relay"));
        assert!(glob_match("my-org/relay", "my-org/relay"));
        assert!(!glob_match("my-org/relay", "my-org/relay2"));
    }

    #[test]
    fn disabled_rule_never_matches() {
        let settings = settings(
            only(PrEventKind::Opened, NotificationTypeRule::disabled()),
            Vec::new(),
        );
        assert!(!should_notify(
            &settings,
            "my-org/relay",
            "main",
            1,
            PrEventKind::Opened
        ));
    }

    #[test]
    fn a_kind_with_no_rule_of_its_own_is_unaffected_by_another_kinds_rule() {
        let settings = settings(
            only(PrEventKind::Opened, NotificationTypeRule::enabled("*")),
            Vec::new(),
        );
        assert!(!should_notify(
            &settings,
            "my-org/relay",
            "main",
            1,
            PrEventKind::CiFailed
        ));
    }

    #[test]
    fn repo_mute_silences_every_status_and_branch() {
        let mut notifications = only(PrEventKind::Opened, NotificationTypeRule::enabled("*"));
        notifications.ci_failed = NotificationTypeRule::enabled("*");
        let settings = settings(notifications, vec!["my-org/relay".to_string()]);
        assert!(!should_notify(
            &settings,
            "my-org/relay",
            "main",
            1,
            PrEventKind::Opened
        ));
        assert!(should_notify(
            &settings,
            "my-org/other",
            "main",
            1,
            PrEventKind::Opened
        ));
    }

    #[test]
    fn branch_mute_only_silences_that_branch() {
        let settings = settings(
            only(PrEventKind::Opened, NotificationTypeRule::enabled("*")),
            vec!["my-org/relay@release/1.0".to_string()],
        );
        assert!(!should_notify(
            &settings,
            "my-org/relay",
            "release/1.0",
            1,
            PrEventKind::Opened
        ));
        assert!(should_notify(
            &settings,
            "my-org/relay",
            "main",
            1,
            PrEventKind::Opened
        ));
    }

    #[test]
    fn pr_mute_only_silences_that_pr() {
        let settings = settings(
            only(PrEventKind::Opened, NotificationTypeRule::enabled("*")),
            vec!["my-org/relay#42".to_string()],
        );
        assert!(!should_notify(
            &settings,
            "my-org/relay",
            "main",
            42,
            PrEventKind::Opened
        ));
        assert!(should_notify(
            &settings,
            "my-org/relay",
            "main",
            43,
            PrEventKind::Opened
        ));
    }

    #[test]
    fn branch_include_and_exclude_narrow_the_rule() {
        let mut rule = NotificationTypeRule::enabled("*");
        rule.branch_include = vec!["release/*".to_string()];
        rule.branch_exclude = vec!["release/legacy".to_string()];
        let settings = settings(only(PrEventKind::Opened, rule), Vec::new());
        assert!(should_notify(
            &settings,
            "my-org/relay",
            "release/1.0",
            1,
            PrEventKind::Opened
        ));
        assert!(!should_notify(
            &settings,
            "my-org/relay",
            "release/legacy",
            1,
            PrEventKind::Opened
        ));
        assert!(!should_notify(
            &settings,
            "my-org/relay",
            "main",
            1,
            PrEventKind::Opened
        ));
    }

    #[test]
    fn default_settings_cover_the_actionable_statuses_but_not_a_green_build_or_a_plain_close() {
        let settings = GithubConnectorSettings::default();
        for kind in [
            PrEventKind::Opened,
            PrEventKind::Merged,
            PrEventKind::ReviewRequested,
            PrEventKind::CiFailed,
        ] {
            assert!(should_notify(&settings, "any/repo", "main", 1, kind));
        }
        for kind in [PrEventKind::CiPassed, PrEventKind::Closed] {
            assert!(!should_notify(&settings, "any/repo", "main", 1, kind));
        }
    }

    #[test]
    fn effective_client_id_treats_blank_or_missing_as_unconfigured() {
        let mut settings = GithubConnectorSettings::default();
        assert_eq!(effective_client_id(&settings), None);

        settings.client_id = Some("   ".to_string());
        assert_eq!(effective_client_id(&settings), None);

        settings.client_id = Some(" Iv1.abc123 ".to_string());
        assert_eq!(effective_client_id(&settings), Some("Iv1.abc123"));
    }

    #[test]
    fn a_wholly_missing_settings_object_deserializes_to_the_friendly_defaults() {
        let settings: GithubConnectorSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings, GithubConnectorSettings::default());
    }

    #[test]
    fn a_notification_kind_missing_from_an_otherwise_present_object_defaults_to_disabled() {
        // Distinct from the whole-object-missing case above: this is what a
        // hand-edited or older settings.json with one key removed decodes
        // to, and "silently off" is the safe direction to fail in.
        let settings: GithubConnectorSettings =
            serde_json::from_str(r#"{"notifications":{}}"#).unwrap();
        for kind in [
            PrEventKind::Opened,
            PrEventKind::Closed,
            PrEventKind::Merged,
            PrEventKind::ReviewRequested,
            PrEventKind::CiFailed,
            PrEventKind::CiPassed,
        ] {
            assert!(!settings.notifications.rule_for(kind).enabled);
        }
    }
}
