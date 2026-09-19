//! The recurring background job: ask GitHub what changed about the
//! signed-in user's pull requests, decide what the user's rules say about
//! each change, and notify through the same job/event pipeline every other
//! producer uses.
//!
//! `run_poll_cycle` is the testable core — generic over `GitHubClient` and
//! `EventSink` exactly the way `jobs::spawn` is, so a full cycle (search,
//! diff, notify) runs against `FakeGitHubClient` and a fake sink with no
//! network and no running Tauri app. `run_poll_loop` is the thin,
//! deliberately less-tested wrapper that adds the two things that need real
//! I/O — reading `settings.json` and reading/writing the on-disk PR cache —
//! the same split `vault.rs` makes between its crypto functions and
//! `read_file`/`write_file`.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::events::{EventSink, NotificationStatus};
use crate::jobs::{self, JobContext, JobRegistry};

use super::client::{CiState, Conditional, GitHubClient};
use super::oauth::{interpret_token_response, DeviceCodeResponse, TokenOutcome};
use super::rules::{should_notify, GithubConnectorSettings, PrEventKind};
use super::token_store::{StoredToken, TokenStore};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackedPr {
    pub state: String,
    pub merged: bool,
    pub ci_state: Option<CiState>,
    pub review_requested: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PollCache {
    #[serde(default)]
    pub search_etag: Option<String>,
    #[serde(default)]
    pub prs: HashMap<String, TrackedPr>,
}

/// `"https://api.github.com/repos/OWNER/REPO"` → `"OWNER/REPO"`. The search
/// API's issue items carry this URL rather than separate owner/repo fields.
pub fn repo_full_name_from_url(repository_url: &str) -> Option<String> {
    repository_url
        .split_once("/repos/")
        .map(|(_, rest)| rest.to_string())
}

/// What changed between two polls of the same pull request. `previous` is
/// `None` the first time a PR is seen, which is itself the "opened" signal —
/// there is no separate "is this new" check.
pub fn diff_pr(previous: Option<&TrackedPr>, current: &TrackedPr) -> Vec<PrEventKind> {
    let mut events = Vec::new();
    match previous {
        None => {
            events.push(PrEventKind::Opened);
            if current.review_requested {
                events.push(PrEventKind::ReviewRequested);
            }
            push_ci_event(&mut events, None, current.ci_state);
        }
        Some(prev) => {
            if !prev.merged && current.merged {
                events.push(PrEventKind::Merged);
            } else if prev.state == "open" && current.state == "closed" && !current.merged {
                events.push(PrEventKind::Closed);
            }
            if !prev.review_requested && current.review_requested {
                events.push(PrEventKind::ReviewRequested);
            }
            push_ci_event(&mut events, prev.ci_state, current.ci_state);
        }
    }
    events
}

fn push_ci_event(
    events: &mut Vec<PrEventKind>,
    previous: Option<CiState>,
    current: Option<CiState>,
) {
    match current {
        Some(CiState::Success) if previous != Some(CiState::Success) => {
            events.push(PrEventKind::CiPassed);
        }
        Some(CiState::Failure) if previous != Some(CiState::Failure) => {
            events.push(PrEventKind::CiFailed);
        }
        _ => {}
    }
}

fn describe(kind: PrEventKind, repo: &str, number: u64, title: &str) -> (String, String) {
    let title_text = match kind {
        PrEventKind::Opened => "Pull request opened",
        PrEventKind::Closed => "Pull request closed",
        PrEventKind::Merged => "Pull request merged",
        PrEventKind::ReviewRequested => "Review requested",
        PrEventKind::CiFailed => "CI failed",
        PrEventKind::CiPassed => "CI passed",
    };
    (title_text.to_string(), format!("{repo}#{number} · {title}"))
}

fn notify_pr_event<S: EventSink>(
    sink: &S,
    registry: &JobRegistry,
    repo: &str,
    kind: PrEventKind,
    number: u64,
    pr_title: &str,
) {
    let (title, detail) = describe(kind, repo, number, pr_title);
    jobs::spawn(
        sink.clone(),
        registry.clone(),
        repo.to_string(),
        move |ctx| async move {
            ctx.report(NotificationStatus::Done, title, Some(detail), None);
            Ok(())
        },
    );
}

/// Waits out a Device Flow login: polls GitHub at the interval it gave us
/// (backing off on `slow_down`) until the user approves it, denies it, or
/// the code expires. `ctx.checkpoint()` between waits means cancelling the
/// job — Relay quitting, or the user backing out mid-flow — stops the
/// polling immediately rather than leaking it until expiry.
pub async fn run_device_flow<C: GitHubClient, S: EventSink, T: TokenStore>(
    ctx: &JobContext<S>,
    client: &C,
    token_store: &T,
    device: DeviceCodeResponse,
) -> Result<StoredToken> {
    let deadline = now_millis() + device.expires_in * 1000;
    let mut wait_secs = device.poll_interval_secs();

    loop {
        ctx.checkpoint()?;
        tokio::time::sleep(Duration::from_secs(wait_secs)).await;
        ctx.checkpoint()?;

        if now_millis() >= deadline {
            ctx.report(
                NotificationStatus::Blocked,
                "GitHub sign-in code expired",
                None,
                None,
            );
            return Err(Error::GithubDeviceFlowExpired);
        }

        let response = client.poll_device_token(&device.device_code).await?;
        match interpret_token_response(response) {
            TokenOutcome::Approved {
                access_token,
                refresh_token,
                expires_in,
            } => {
                let username = client.fetch_viewer_login(&access_token).await?;
                let stored = StoredToken {
                    access_token,
                    refresh_token,
                    expires_at: expires_in.map(|secs| now_millis() + secs * 1000),
                    username,
                };
                token_store.set(&stored)?;
                return Ok(stored);
            }
            TokenOutcome::Pending => continue,
            TokenOutcome::SlowDown => {
                wait_secs += 5;
                continue;
            }
            TokenOutcome::Denied => {
                ctx.report(
                    NotificationStatus::Blocked,
                    "GitHub sign-in declined",
                    None,
                    None,
                );
                return Err(Error::GithubDeviceFlowDenied);
            }
            TokenOutcome::Expired => {
                ctx.report(
                    NotificationStatus::Blocked,
                    "GitHub sign-in code expired",
                    None,
                    None,
                );
                return Err(Error::GithubDeviceFlowExpired);
            }
            TokenOutcome::Failed(reason) => {
                ctx.report(
                    NotificationStatus::Blocked,
                    "GitHub sign-in failed",
                    Some(reason.clone()),
                    None,
                );
                return Err(Error::GithubRequestFailed(reason));
            }
        }
    }
}

/// One pass: fetch the involved-PR search, and for anything it returns,
/// fetch enough detail to diff against the cache and fire whatever
/// notifications the user's rules call for. Returns without touching the
/// cache at all when GitHub answers 304 — that is the point of sending the
/// ETag in the first place.
pub async fn run_poll_cycle<C: GitHubClient, S: EventSink>(
    client: &C,
    sink: &S,
    registry: &JobRegistry,
    token: &str,
    username: &str,
    settings: &GithubConnectorSettings,
    cache: &mut PollCache,
) -> Result<()> {
    let items = match client
        .search_involved_prs(token, username, cache.search_etag.as_deref())
        .await?
    {
        Conditional::NotModified => return Ok(()),
        Conditional::Fresh { value, etag } => {
            cache.search_etag = etag;
            value
        }
    };

    for item in items {
        let Some(repo) = repo_full_name_from_url(&item.repository_url) else {
            continue;
        };
        let Some((owner, name)) = repo.split_once('/') else {
            continue;
        };

        let detail = client.fetch_pr(token, owner, name, item.number).await?;
        let ci_state = client
            .fetch_ci_state(token, owner, name, &detail.head.sha)
            .await?;
        let current = TrackedPr {
            state: detail.state.clone(),
            merged: detail.merged,
            ci_state,
            review_requested: detail
                .requested_reviewers
                .iter()
                .any(|reviewer| reviewer.login == username),
        };

        let key = format!("{repo}#{}", item.number);
        let events = diff_pr(cache.prs.get(&key), &current);
        for kind in events {
            if should_notify(settings, &repo, &detail.base.git_ref, item.number, kind) {
                notify_pr_event(sink, registry, &repo, kind, item.number, &item.title);
            }
        }
        cache.prs.insert(key, current);
    }

    Ok(())
}

/// A refresh is worth attempting once the token is within five minutes of
/// its expiry (or already past it) — early enough that a slow network call
/// does not race the actual expiration.
const REFRESH_SKEW_MILLIS: u64 = 5 * 60 * 1000;

pub fn needs_refresh(expires_at: Option<u64>, now_millis: u64) -> bool {
    match expires_at {
        None => false,
        Some(expires_at) => now_millis + REFRESH_SKEW_MILLIS >= expires_at,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn refresh_stored_token<C: GitHubClient>(
    client: &C,
    stored: &StoredToken,
) -> Result<StoredToken> {
    let Some(refresh_token) = &stored.refresh_token else {
        return Ok(stored.clone());
    };
    let response = client.refresh_token(refresh_token).await?;
    let outcome = super::oauth::interpret_token_response(response);
    match outcome {
        super::oauth::TokenOutcome::Approved {
            access_token,
            refresh_token,
            expires_in,
        } => Ok(StoredToken {
            access_token,
            refresh_token: refresh_token.or_else(|| stored.refresh_token.clone()),
            expires_at: expires_in.map(|secs| now_millis() + secs * 1000),
            username: stored.username.clone(),
        }),
        other => Err(crate::error::Error::GithubRequestFailed(format!(
            "token refresh failed: {other:?}"
        ))),
    }
}

fn load_cache(path: &Path) -> PollCache {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_cache(path: &Path, cache: &PollCache) {
    let Ok(raw) = serde_json::to_string_pretty(cache) else {
        return;
    };
    if let Err(error) = std::fs::write(path, raw) {
        log::warn!("could not persist the GitHub poll cache: {error}");
    }
}

/// Runs until cancelled or until the token disappears (the user
/// disconnected). Re-reads settings and the token on every cycle, so a
/// changed poll interval or a new set of rules takes effect on the next
/// tick without restarting the job.
#[allow(clippy::too_many_arguments)]
pub async fn run_poll_loop<C, S, T>(
    ctx: JobContext<S>,
    client: C,
    token_store: std::sync::Arc<T>,
    registry: JobRegistry,
    sink: S,
    cache_path: std::path::PathBuf,
    read_settings: impl Fn() -> GithubConnectorSettings,
) -> Result<()>
where
    C: GitHubClient,
    S: EventSink,
    T: TokenStore,
{
    let mut cache = load_cache(&cache_path);

    loop {
        ctx.checkpoint()?;

        let Some(mut stored) = token_store.get()? else {
            return Ok(());
        };

        if needs_refresh(stored.expires_at, now_millis()) {
            match refresh_stored_token(&client, &stored).await {
                Ok(refreshed) => {
                    token_store.set(&refreshed)?;
                    stored = refreshed;
                }
                Err(error) => log::warn!("could not refresh the GitHub token: {error}"),
            }
        }

        let settings = read_settings();
        match run_poll_cycle(
            &client,
            &sink,
            &registry,
            &stored.access_token,
            &stored.username,
            &settings,
            &mut cache,
        )
        .await
        {
            Ok(()) => save_cache(&cache_path, &cache),
            Err(error) => log::warn!("GitHub poll cycle failed: {error}"),
        }

        tokio::time::sleep(Duration::from_secs(settings.poll_interval_secs)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::super::client::fake::FakeGitHubClient;
    use super::super::client::{
        PullRequestDetail, PullRequestRef, PullRequestUser, SearchIssueItem,
    };
    use super::super::rules::NotificationRule;
    use super::super::token_store::fake::FakeTokenStore;
    use super::*;
    use crate::jobs::fake::FakeSink;

    #[test]
    fn repo_full_name_parses_the_search_api_url() {
        assert_eq!(
            repo_full_name_from_url("https://api.github.com/repos/my-org/relay"),
            Some("my-org/relay".to_string())
        );
        assert_eq!(repo_full_name_from_url("not a url"), None);
    }

    fn tracked(state: &str, merged: bool, ci: Option<CiState>, review: bool) -> TrackedPr {
        TrackedPr {
            state: state.to_string(),
            merged,
            ci_state: ci,
            review_requested: review,
        }
    }

    #[test]
    fn a_new_pr_is_opened_and_carries_its_current_ci_and_review_state() {
        let current = tracked("open", false, Some(CiState::Failure), true);
        let events = diff_pr(None, &current);
        assert_eq!(
            events,
            vec![
                PrEventKind::Opened,
                PrEventKind::ReviewRequested,
                PrEventKind::CiFailed
            ]
        );
    }

    #[test]
    fn merging_fires_merged_not_closed() {
        let previous = tracked("open", false, None, false);
        let current = tracked("closed", true, None, false);
        assert_eq!(
            diff_pr(Some(&previous), &current),
            vec![PrEventKind::Merged]
        );
    }

    #[test]
    fn closing_without_merging_fires_closed() {
        let previous = tracked("open", false, None, false);
        let current = tracked("closed", false, None, false);
        assert_eq!(
            diff_pr(Some(&previous), &current),
            vec![PrEventKind::Closed]
        );
    }

    #[test]
    fn ci_flipping_to_failure_then_back_to_success_fires_both_transitions_once_each() {
        let opened = tracked("open", false, None, false);
        let failed = tracked("open", false, Some(CiState::Failure), false);
        let passed = tracked("open", false, Some(CiState::Success), false);

        assert_eq!(diff_pr(Some(&opened), &failed), vec![PrEventKind::CiFailed]);
        assert_eq!(diff_pr(Some(&failed), &passed), vec![PrEventKind::CiPassed]);
        // Staying success a second poll in a row is not a new event.
        assert_eq!(diff_pr(Some(&passed), &passed), Vec::<PrEventKind>::new());
    }

    #[test]
    fn no_change_produces_no_events() {
        let state = tracked("open", false, Some(CiState::Success), false);
        assert_eq!(diff_pr(Some(&state), &state), Vec::<PrEventKind>::new());
    }

    #[test]
    fn refresh_is_needed_once_within_the_skew_window_or_past_expiry() {
        assert!(!needs_refresh(None, 1_000));
        assert!(!needs_refresh(Some(1_000_000), 0));
        assert!(needs_refresh(Some(1_000), 1_000));
        assert!(needs_refresh(Some(1_000), 10));
    }

    fn pr_detail(
        number: u64,
        state: &str,
        merged: bool,
        sha: &str,
        base: &str,
    ) -> PullRequestDetail {
        PullRequestDetail {
            number,
            title: "Fix the thing".to_string(),
            html_url: format!("https://github.com/my-org/relay/pull/{number}"),
            state: state.to_string(),
            merged,
            head: PullRequestRef {
                sha: sha.to_string(),
                git_ref: "feature".to_string(),
            },
            base: PullRequestRef {
                sha: "base-sha".to_string(),
                git_ref: base.to_string(),
            },
            requested_reviewers: vec![PullRequestUser {
                login: "octocat".to_string(),
            }],
        }
    }

    #[tokio::test]
    async fn a_poll_cycle_notifies_for_a_newly_seen_pr_matching_the_rules() {
        let client = FakeGitHubClient::default();
        client.searches.lock().unwrap().push(Ok(Conditional::Fresh {
            value: vec![SearchIssueItem {
                number: 7,
                title: "Fix the thing".to_string(),
                repository_url: "https://api.github.com/repos/my-org/relay".to_string(),
            }],
            etag: Some("etag-1".to_string()),
        }));
        client.prs.lock().unwrap().insert(
            ("my-org".to_string(), "relay".to_string(), 7),
            Ok(pr_detail(7, "open", false, "sha1", "main")),
        );
        client
            .ci_states
            .lock()
            .unwrap()
            .insert("my-org/relay@sha1".to_string(), Ok(Some(CiState::Failure)));

        let sink = FakeSink::default();
        let registry = JobRegistry::default();
        let settings = GithubConnectorSettings {
            poll_interval_secs: 300,
            rules: vec![NotificationRule {
                id: "r".to_string(),
                enabled: true,
                repo_pattern: "*".to_string(),
                branch_include: Vec::new(),
                branch_exclude: Vec::new(),
                statuses: vec![
                    PrEventKind::Opened,
                    PrEventKind::CiFailed,
                    PrEventKind::ReviewRequested,
                ],
            }],
            muted: Vec::new(),
        };
        let mut cache = PollCache::default();

        run_poll_cycle(
            &client, &sink, &registry, "token", "octocat", &settings, &mut cache,
        )
        .await
        .unwrap();

        for _ in 0..50 {
            if sink.events().len() >= 6 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        assert_eq!(cache.search_etag.as_deref(), Some("etag-1"));
        assert!(cache.prs.contains_key("my-org/relay#7"));

        let titles: Vec<String> = sink
            .events()
            .iter()
            .filter_map(|event| match event {
                crate::events::AppEvent::Notification { title, .. } => Some(title.clone()),
                _ => None,
            })
            .collect();
        assert!(titles.contains(&"Pull request opened".to_string()));
        assert!(titles.contains(&"CI failed".to_string()));
        assert!(titles.contains(&"Review requested".to_string()));
    }

    #[tokio::test]
    async fn a_304_leaves_the_cache_untouched() {
        let client = FakeGitHubClient::default();
        client
            .searches
            .lock()
            .unwrap()
            .push(Ok(Conditional::NotModified));

        let sink = FakeSink::default();
        let registry = JobRegistry::default();
        let settings = GithubConnectorSettings::default();
        let mut cache = PollCache {
            search_etag: Some("still-fresh".to_string()),
            prs: HashMap::new(),
        };

        run_poll_cycle(
            &client, &sink, &registry, "token", "octocat", &settings, &mut cache,
        )
        .await
        .unwrap();

        assert_eq!(cache.search_etag.as_deref(), Some("still-fresh"));
        assert!(sink.events().is_empty());
    }

    fn device_code(expires_in: u64, interval: u64) -> DeviceCodeResponse {
        DeviceCodeResponse {
            device_code: "dc".to_string(),
            user_code: "ABCD-EFGH".to_string(),
            verification_uri: "https://github.com/login/device".to_string(),
            expires_in,
            interval: Some(interval),
        }
    }

    fn test_ctx(sink: FakeSink) -> JobContext<FakeSink> {
        crate::jobs::fake::context(sink, Arc::new(std::sync::atomic::AtomicBool::new(false)))
    }

    #[tokio::test]
    async fn run_device_flow_stores_the_token_once_approved() {
        let client = FakeGitHubClient::default();
        client
            .token_polls
            .lock()
            .unwrap()
            .push(Ok(super::super::oauth::TokenResponse {
                access_token: None,
                refresh_token: None,
                expires_in: None,
                error: Some("authorization_pending".to_string()),
            }));
        client
            .token_polls
            .lock()
            .unwrap()
            .push(Ok(super::super::oauth::TokenResponse {
                access_token: Some("gho_abc".to_string()),
                refresh_token: None,
                expires_in: None,
                error: None,
            }));
        client
            .viewer_login
            .lock()
            .unwrap()
            .push(Ok("octocat".to_string()));

        let token_store = FakeTokenStore::default();
        let ctx = test_ctx(FakeSink::default());
        let stored = run_device_flow(&ctx, &client, &token_store, device_code(900, 0))
            .await
            .unwrap();

        assert_eq!(stored.access_token, "gho_abc");
        assert_eq!(stored.username, "octocat");
        assert_eq!(token_store.get().unwrap(), Some(stored));
    }

    #[tokio::test]
    async fn run_device_flow_fails_when_the_user_denies_it() {
        let client = FakeGitHubClient::default();
        client
            .token_polls
            .lock()
            .unwrap()
            .push(Ok(super::super::oauth::TokenResponse {
                access_token: None,
                refresh_token: None,
                expires_in: None,
                error: Some("access_denied".to_string()),
            }));
        let token_store = FakeTokenStore::default();
        let ctx = test_ctx(FakeSink::default());

        let result = run_device_flow(&ctx, &client, &token_store, device_code(900, 0)).await;
        assert!(matches!(result, Err(Error::GithubDeviceFlowDenied)));
        assert_eq!(token_store.get().unwrap(), None);
    }

    #[tokio::test]
    async fn run_device_flow_expires_once_the_deadline_has_passed() {
        let client = FakeGitHubClient::default();
        let token_store = FakeTokenStore::default();
        let ctx = test_ctx(FakeSink::default());

        // expires_in: 0 means the deadline is already behind us the first
        // time it's checked, so this returns without consuming a scripted
        // poll response at all.
        let result = run_device_flow(&ctx, &client, &token_store, device_code(0, 0)).await;
        assert!(matches!(result, Err(Error::GithubDeviceFlowExpired)));
    }

    #[tokio::test]
    async fn the_loop_stops_immediately_once_disconnected() {
        let client = FakeGitHubClient::default();
        let token_store = Arc::new(FakeTokenStore::default());
        let sink = FakeSink::default();
        let registry = JobRegistry::default();
        let ctx = test_ctx(sink.clone());

        let result = run_poll_loop(
            ctx,
            client,
            token_store,
            registry,
            sink,
            std::env::temp_dir().join("relay-github-poll-cache-test.json"),
            GithubConnectorSettings::default,
        )
        .await;

        assert!(result.is_ok());
    }
}
