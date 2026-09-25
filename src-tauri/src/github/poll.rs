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
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::events::{EventSink, NotificationAction, NotificationStatus, INFO_AUTO_DISMISS_MS};
use crate::jobs::{self, JobContext, JobRegistry, NotificationOptions};

use super::client::{CiState, Conditional, GitHubClient};
use super::oauth::{interpret_token_response, DeviceCodeResponse, TokenOutcome};
use super::rules::{should_notify, GithubConnectorSettings, PrEventKind};
use super::token_store::{StoredToken, TokenStore};

static POLL_CACHE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackedPr {
    pub state: String,
    pub merged: bool,
    pub ci_state: Option<CiState>,
    pub review_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSnapshot {
    pub repository: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub review_requested: bool,
    pub ci_state: Option<CiState>,
    pub last_seen: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PollCache {
    #[serde(default)]
    pub search_etag: Option<String>,
    #[serde(default)]
    pub prs: HashMap<String, TrackedPr>,
    #[serde(default)]
    pub details: HashMap<String, PullRequestSnapshot>,
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
    pr_url: &str,
) {
    let (title, detail) = describe(kind, repo, number, pr_title);
    let notification_id = format!("{repo}#{number}:{kind:?}");
    let pr_url = pr_url.to_string();
    jobs::spawn(
        sink.clone(),
        registry.clone(),
        repo.to_string(),
        move |ctx| async move {
            ctx.report_notification(
                NotificationStatus::Done,
                title,
                Some(detail),
                None,
                NotificationOptions {
                    notification_id,
                    auto_dismiss_ms: Some(INFO_AUTO_DISMISS_MS),
                    actions: vec![NotificationAction::Open {
                        label: "Open".to_string(),
                        url: pr_url,
                    }],
                },
            );
            Ok(())
        },
    );
}

/// Waits out a Device Flow login: polls GitHub at the interval it gave us
/// (backing off on `slow_down`) until the user approves it, denies it, or
/// the code expires. `ctx.checkpoint()` between waits means cancelling the
/// job — Relay quitting, or the user backing out mid-flow — stops the
/// polling immediately rather than leaking it until expiry.
///
/// Every failure path — denied, expired, a bad response from GitHub, a
/// network error, a keychain write that fails — is funneled through one
/// `ctx.report(Blocked, ...)` carrying the real error text before returning
/// it, rather than reporting only the handful of outcomes this function
/// itself distinguishes. Without that, a failure past the point GitHub
/// approves the code (fetching the username, writing to the keychain) would
/// reach the frontend as a bare `NotificationDone { ok: false }` with no way
/// to say why.
pub async fn run_device_flow<C: GitHubClient, S: EventSink, T: TokenStore>(
    ctx: &JobContext<S>,
    client: &C,
    token_store: &T,
    client_id: &str,
    device: DeviceCodeResponse,
) -> Result<StoredToken> {
    let result = run_device_flow_inner(ctx, client, token_store, client_id, device).await;
    // A cancelled job is an intentional, user-initiated outcome (backing out
    // of the flow) rather than a failure needing an explanation — the
    // frontend already updates its own state the moment it asks to cancel.
    if let Err(error) = &result {
        if matches!(error, Error::JobCancelled(_)) {
            log::info!("github: connect job cancelled");
        } else {
            log::warn!("github: device flow failed: {error}");
            ctx.report(NotificationStatus::Blocked, error.to_string(), None, None);
        }
    }
    result
}

fn describe_outcome(outcome: &TokenOutcome) -> String {
    match outcome {
        TokenOutcome::Approved { .. } => "approved".to_string(),
        TokenOutcome::Pending => "pending".to_string(),
        TokenOutcome::SlowDown => "slow_down".to_string(),
        TokenOutcome::Denied => "denied".to_string(),
        TokenOutcome::Expired => "expired".to_string(),
        TokenOutcome::Failed(reason) => format!("failed ({reason})"),
    }
}

async fn run_device_flow_inner<C: GitHubClient, S: EventSink, T: TokenStore>(
    ctx: &JobContext<S>,
    client: &C,
    token_store: &T,
    client_id: &str,
    device: DeviceCodeResponse,
) -> Result<StoredToken> {
    let deadline = now_millis() + device.expires_in * 1000;
    let mut wait_secs = device.poll_interval_secs();
    let mut attempt: u32 = 0;

    loop {
        ctx.checkpoint()?;
        log::info!("github: waiting {wait_secs}s before the next poll (attempt {attempt})");
        tokio::time::sleep(Duration::from_secs(wait_secs)).await;
        ctx.checkpoint()?;

        if now_millis() >= deadline {
            log::warn!("github: device code expired before it was approved");
            return Err(Error::GithubDeviceFlowExpired);
        }

        attempt += 1;
        log::info!("github: polling for approval (attempt {attempt})");
        let response = client
            .poll_device_token(client_id, &device.device_code)
            .await?;
        let outcome = interpret_token_response(response);
        // Never log `outcome` via its derived `Debug` — `Approved` carries
        // the raw access token, and this line must never put a bearer
        // credential into a log file.
        log::info!(
            "github: poll attempt {attempt} outcome: {}",
            describe_outcome(&outcome)
        );
        match outcome {
            TokenOutcome::Approved {
                access_token,
                refresh_token,
                expires_in,
            } => {
                log::info!("github: approved, fetching the username");
                let username = client.fetch_viewer_login(&access_token).await?;
                let stored = StoredToken {
                    access_token,
                    refresh_token,
                    expires_at: expires_in.map(|secs| now_millis() + secs * 1000),
                    username,
                };
                log::info!("github: writing the token to the keychain");
                token_store.set(&stored).await?;
                log::info!("github: token stored");
                return Ok(stored);
            }
            TokenOutcome::Pending => continue,
            TokenOutcome::SlowDown => {
                wait_secs += 5;
                continue;
            }
            TokenOutcome::Denied => return Err(Error::GithubDeviceFlowDenied),
            TokenOutcome::Expired => return Err(Error::GithubDeviceFlowExpired),
            TokenOutcome::Failed(reason) => return Err(Error::GithubRequestFailed(reason)),
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
                notify_pr_event(
                    sink,
                    registry,
                    &repo,
                    kind,
                    item.number,
                    &item.title,
                    &detail.html_url,
                );
            }
        }
        cache.prs.insert(key.clone(), current.clone());
        cache.details.insert(
            key,
            PullRequestSnapshot {
                repository: repo,
                number: item.number,
                title: item.title,
                url: detail.html_url,
                state: detail.state,
                review_requested: current.review_requested,
                ci_state: current.ci_state,
                last_seen: now_millis(),
            },
        );
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
    client_id: &str,
    stored: &StoredToken,
) -> Result<StoredToken> {
    let Some(refresh_token) = &stored.refresh_token else {
        return Ok(stored.clone());
    };
    let response = client.refresh_token(client_id, refresh_token).await?;
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
    let _guard = POLL_CACHE_LOCK.lock().unwrap();
    read_cache(path)
}

fn read_cache(path: &Path) -> PollCache {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn recent_pull_requests(path: &Path) -> Vec<PullRequestSnapshot> {
    let mut pull_requests: Vec<_> = load_cache(path)
        .details
        .into_values()
        .filter(|pull_request| pull_request.state == "open")
        .collect();
    pull_requests.sort_by_key(|pull_request| std::cmp::Reverse(pull_request.last_seen));
    pull_requests
}

pub async fn refresh_from_webhook<C: GitHubClient>(
    app: &tauri::AppHandle,
    client: &C,
    token: &str,
    username: &str,
    repo: &str,
    number: u64,
) -> Result<PullRequestSnapshot> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| Error::GithubRequestFailed("invalid webhook repository".into()))?;
    let detail = client.fetch_pr(token, owner, name, number).await?;
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
    let snapshot = PullRequestSnapshot {
        repository: repo.to_string(),
        number,
        title: detail.title,
        url: detail.html_url,
        state: detail.state,
        review_requested: current.review_requested,
        ci_state: current.ci_state,
        last_seen: now_millis(),
    };
    let path = super::poll_cache_path(app);
    let mut cache = load_cache(&path);
    let key = format!("{repo}#{number}");
    cache.prs.insert(key.clone(), current);
    cache.details.insert(key, snapshot.clone());
    save_cache_checked(&path, &cache)?;
    Ok(snapshot)
}

fn save_cache(path: &Path, cache: &PollCache) {
    if let Err(error) = save_cache_checked(path, cache) {
        log::warn!("could not persist the GitHub poll cache: {error}");
    }
}

fn save_cache_checked(path: &Path, cache: &PollCache) -> Result<()> {
    let _guard = POLL_CACHE_LOCK.lock().unwrap();
    let mut merged = read_cache(path);
    if cache.search_etag.is_some() {
        merged.search_etag = cache.search_etag.clone();
    }
    for (key, incoming) in &cache.prs {
        let existing_seen = merged
            .details
            .get(key)
            .map_or(0, |snapshot| snapshot.last_seen);
        let incoming_seen = cache
            .details
            .get(key)
            .map_or(0, |snapshot| snapshot.last_seen);
        if existing_seen > incoming_seen {
            continue;
        }
        merged.prs.insert(key.clone(), incoming.clone());
        if let Some(snapshot) = cache.details.get(key) {
            merged.details.insert(key.clone(), snapshot.clone());
        }
    }
    let serialized = serde_json::to_vec_pretty(&merged)
        .map_err(|error| Error::GithubRequestFailed(error.to_string()))?;
    std::fs::write(path, serialized)?;
    Ok(())
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
    loop {
        ctx.checkpoint()?;

        let settings = read_settings();
        let stored = match token_store.get().await {
            Ok(stored) => stored,
            Err(error) => {
                log::warn!("could not read the GitHub credential: {error}");
                tokio::time::sleep(Duration::from_secs(settings.poll_interval_secs)).await;
                continue;
            }
        };
        let Some(mut stored) = stored else {
            log::info!("github: poll loop found no token, stopping");
            return Ok(());
        };

        if needs_refresh(stored.expires_at, now_millis()) {
            if let Some(client_id) = super::rules::effective_client_id(&settings) {
                match refresh_stored_token(&client, client_id, &stored).await {
                    Ok(refreshed) => {
                        token_store.set(&refreshed).await?;
                        stored = refreshed;
                    }
                    Err(error) => log::warn!("could not refresh the GitHub token: {error}"),
                }
            } else {
                log::warn!("GitHub token needs refreshing but no client id is configured");
            }
        }

        let mut cache = load_cache(&cache_path);
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

    #[test]
    fn recent_pull_requests_filters_closed_entries_and_sorts_by_last_seen() {
        let path = std::env::temp_dir().join(format!(
            "relay-github-pull-requests-{}.json",
            std::process::id()
        ));
        let mut cache = PollCache::default();
        cache.details.insert(
            "my-org/relay#7".to_string(),
            PullRequestSnapshot {
                repository: "my-org/relay".to_string(),
                number: 7,
                title: "Older".to_string(),
                url: "https://github.com/my-org/relay/pull/7".to_string(),
                state: "open".to_string(),
                review_requested: false,
                ci_state: None,
                last_seen: 100,
            },
        );
        cache.details.insert(
            "my-org/relay#8".to_string(),
            PullRequestSnapshot {
                repository: "my-org/relay".to_string(),
                number: 8,
                title: "Closed".to_string(),
                url: "https://github.com/my-org/relay/pull/8".to_string(),
                state: "closed".to_string(),
                review_requested: false,
                ci_state: None,
                last_seen: 300,
            },
        );
        cache.details.insert(
            "my-org/relay#9".to_string(),
            PullRequestSnapshot {
                repository: "my-org/relay".to_string(),
                number: 9,
                title: "Newer".to_string(),
                url: "https://github.com/my-org/relay/pull/9".to_string(),
                state: "open".to_string(),
                review_requested: false,
                ci_state: None,
                last_seen: 200,
            },
        );
        save_cache(&path, &cache);

        let result = recent_pull_requests(&path);
        let numbers: Vec<_> = result
            .into_iter()
            .map(|pull_request| pull_request.number)
            .collect();
        let _ = std::fs::remove_file(path);
        assert_eq!(numbers, vec![9, 7]);
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
        // Opened, CI-failed and review-requested are all on by default —
        // exactly the three events this newly-seen PR fires.
        let settings = GithubConnectorSettings::default();
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
            details: HashMap::new(),
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

    struct FailingTokenStore;

    #[async_trait::async_trait]
    impl TokenStore for FailingTokenStore {
        async fn get(&self) -> Result<Option<StoredToken>> {
            Ok(None)
        }

        async fn set(&self, _token: &StoredToken) -> Result<()> {
            Err(Error::TokenStore("simulated keychain failure".to_string()))
        }

        async fn clear(&self) -> Result<()> {
            Ok(())
        }
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
        let stored = run_device_flow(
            &ctx,
            &client,
            &token_store,
            "client-id",
            device_code(900, 0),
        )
        .await
        .unwrap();

        assert_eq!(stored.access_token, "gho_abc");
        assert_eq!(stored.username, "octocat");
        assert_eq!(token_store.get().await.unwrap(), Some(stored));
    }

    fn blocked_titles(sink: &FakeSink) -> Vec<String> {
        sink.events()
            .iter()
            .filter_map(|event| match event {
                crate::events::AppEvent::Notification {
                    status: NotificationStatus::Blocked,
                    title,
                    ..
                } => Some(title.clone()),
                _ => None,
            })
            .collect()
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
        let sink = FakeSink::default();
        let ctx = test_ctx(sink.clone());

        let result = run_device_flow(
            &ctx,
            &client,
            &token_store,
            "client-id",
            device_code(900, 0),
        )
        .await;
        assert!(matches!(result, Err(Error::GithubDeviceFlowDenied)));
        assert_eq!(token_store.get().await.unwrap(), None);
        assert_eq!(
            blocked_titles(&sink),
            vec![Error::GithubDeviceFlowDenied.to_string()]
        );
    }

    #[tokio::test]
    async fn run_device_flow_expires_once_the_deadline_has_passed() {
        let client = FakeGitHubClient::default();
        let token_store = FakeTokenStore::default();
        let sink = FakeSink::default();
        let ctx = test_ctx(sink.clone());

        // expires_in: 0 means the deadline is already behind us the first
        // time it's checked, so this returns without consuming a scripted
        // poll response at all.
        let result =
            run_device_flow(&ctx, &client, &token_store, "client-id", device_code(0, 0)).await;
        assert!(matches!(result, Err(Error::GithubDeviceFlowExpired)));
        assert_eq!(
            blocked_titles(&sink),
            vec![Error::GithubDeviceFlowExpired.to_string()]
        );
    }

    #[tokio::test]
    async fn a_failure_after_approval_is_reported_with_its_real_reason_not_silently() {
        // Approval can still be followed by a failure Relay didn't
        // specifically anticipate — a keychain write that fails, here. That
        // must not vanish into a bare `NotificationDone { ok: false }`.
        let client = FakeGitHubClient::default();
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
        let token_store = FailingTokenStore;
        let sink = FakeSink::default();
        let ctx = test_ctx(sink.clone());

        let result = run_device_flow(
            &ctx,
            &client,
            &token_store,
            "client-id",
            device_code(900, 0),
        )
        .await;

        assert!(matches!(result, Err(Error::TokenStore(_))));
        let titles = blocked_titles(&sink);
        assert_eq!(titles.len(), 1);
        assert!(
            titles[0].contains("simulated keychain failure"),
            "title was: {}",
            titles[0]
        );
    }

    #[tokio::test]
    async fn cancelling_mid_flow_reports_nothing_blocked() {
        let client = FakeGitHubClient::default();
        let token_store = FakeTokenStore::default();
        let sink = FakeSink::default();
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let ctx = crate::jobs::fake::context(sink.clone(), cancelled);

        let result = run_device_flow(
            &ctx,
            &client,
            &token_store,
            "client-id",
            device_code(900, 0),
        )
        .await;

        assert!(matches!(result, Err(Error::JobCancelled(_))));
        assert!(blocked_titles(&sink).is_empty());
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
