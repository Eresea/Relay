//! What the user wants to hear about, and what to leave alone.
//!
//! Not secret, so this lives in `settings.json` next to theme and autostart
//! (one JSON value under the key `github.settings`) rather than behind the
//! token store — both the frontend settings page and the Rust-side poll loop
//! read it from the same file, through `tauri_plugin_store`, so there is one
//! source of truth instead of two copies that can drift.

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
pub struct NotificationRule {
    pub id: String,
    #[serde(default = "default_true")]
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
    pub statuses: Vec<PrEventKind>,
}

fn default_true() -> bool {
    true
}

fn default_poll_interval_secs() -> u64 {
    300
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnectorSettings {
    #[serde(default = "default_poll_interval_secs")]
    pub poll_interval_secs: u64,
    #[serde(default)]
    pub rules: Vec<NotificationRule>,
    /// Exact-match exceptions, checked before any rule — see `mute_keys`.
    #[serde(default)]
    pub muted: Vec<String>,
}

impl Default for GithubConnectorSettings {
    /// A fresh connection should not be silent, but it also should not spam:
    /// every repo, every branch, the statuses that call for a look (opened,
    /// merged, a review request, a red build) and not the one that mostly
    /// confirms nothing is wrong (a green build) — that one is opt-in per
    /// rule since a passing check on every PR you touch gets old fast.
    fn default() -> Self {
        Self {
            poll_interval_secs: default_poll_interval_secs(),
            rules: vec![NotificationRule {
                id: "default".to_string(),
                enabled: true,
                repo_pattern: "*".to_string(),
                branch_include: Vec::new(),
                branch_exclude: Vec::new(),
                statuses: vec![
                    PrEventKind::Opened,
                    PrEventKind::Merged,
                    PrEventKind::ReviewRequested,
                    PrEventKind::CiFailed,
                ],
            }],
            muted: Vec::new(),
        }
    }
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

fn branch_matches(rule: &NotificationRule, branch: &str) -> bool {
    let included =
        rule.branch_include.is_empty() || rule.branch_include.iter().any(|p| glob_match(p, branch));
    included && !rule.branch_exclude.iter().any(|p| glob_match(p, branch))
}

/// Whether `kind` on this pull request should reach the user, per their
/// rules and exceptions. Mutes always win; among rules, any enabled match is
/// enough — there is no "most specific rule wins" precedence to reason
/// about, since a user who wants an exception writes it as a mute instead.
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
    settings.rules.iter().any(|rule| {
        rule.enabled
            && glob_match(&rule.repo_pattern, repo)
            && branch_matches(rule, branch)
            && rule.statuses.contains(&kind)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(repo_pattern: &str, statuses: &[PrEventKind]) -> NotificationRule {
        NotificationRule {
            id: "r".to_string(),
            enabled: true,
            repo_pattern: repo_pattern.to_string(),
            branch_include: Vec::new(),
            branch_exclude: Vec::new(),
            statuses: statuses.to_vec(),
        }
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
        let mut settings = GithubConnectorSettings {
            poll_interval_secs: 300,
            rules: vec![rule("*", &[PrEventKind::Opened])],
            muted: Vec::new(),
        };
        settings.rules[0].enabled = false;
        assert!(!should_notify(
            &settings,
            "my-org/relay",
            "main",
            1,
            PrEventKind::Opened
        ));
    }

    #[test]
    fn repo_mute_silences_every_status_and_branch() {
        let settings = GithubConnectorSettings {
            poll_interval_secs: 300,
            rules: vec![rule("*", &[PrEventKind::Opened, PrEventKind::CiFailed])],
            muted: vec!["my-org/relay".to_string()],
        };
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
        let settings = GithubConnectorSettings {
            poll_interval_secs: 300,
            rules: vec![rule("*", &[PrEventKind::Opened])],
            muted: vec!["my-org/relay@release/1.0".to_string()],
        };
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
        let settings = GithubConnectorSettings {
            poll_interval_secs: 300,
            rules: vec![rule("*", &[PrEventKind::Opened])],
            muted: vec!["my-org/relay#42".to_string()],
        };
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
        let mut r = rule("*", &[PrEventKind::Opened]);
        r.branch_include = vec!["release/*".to_string()];
        r.branch_exclude = vec!["release/legacy".to_string()];
        let settings = GithubConnectorSettings {
            poll_interval_secs: 300,
            rules: vec![r],
            muted: Vec::new(),
        };
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
    fn status_not_in_the_rule_does_not_notify() {
        let settings = GithubConnectorSettings {
            poll_interval_secs: 300,
            rules: vec![rule("*", &[PrEventKind::Opened])],
            muted: Vec::new(),
        };
        assert!(!should_notify(
            &settings,
            "my-org/relay",
            "main",
            1,
            PrEventKind::CiFailed
        ));
    }

    #[test]
    fn default_settings_cover_the_actionable_statuses_but_not_a_green_build() {
        let settings = GithubConnectorSettings::default();
        for kind in [
            PrEventKind::Opened,
            PrEventKind::Merged,
            PrEventKind::ReviewRequested,
            PrEventKind::CiFailed,
        ] {
            assert!(should_notify(&settings, "any/repo", "main", 1, kind));
        }
        assert!(!should_notify(
            &settings,
            "any/repo",
            "main",
            1,
            PrEventKind::CiPassed
        ));
    }
}
