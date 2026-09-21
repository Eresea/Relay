//! Talking to GitHub: the two device-flow endpoints on `github.com`, and the
//! REST API on `api.github.com` for the signed-in user's pull requests.
//!
//! Every method is on a trait so `poll::run_poll_cycle` and
//! `poll::run_device_flow` can be tested against canned responses (see
//! `fake` below) rather than a live GitHub — the same split `jobs::spawn`
//! makes with `EventSink`.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

use super::oauth::{DeviceCodeResponse, TokenResponse};

/// A conditionally-fetched resource. `NotModified` means GitHub answered 304
/// against the ETag Relay sent — the poll loop treats that exactly like "no
/// change" and, importantly, it does not count against the API rate limit,
/// which is the whole reason to send `If-None-Match` on every poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Conditional<T> {
    Fresh { value: T, etag: Option<String> },
    NotModified,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SearchIssueItem {
    pub number: u64,
    pub title: String,
    /// `"https://api.github.com/repos/OWNER/REPO"` — parsed by
    /// `poll::repo_full_name_from_url` rather than a second field, since
    /// that is the only place the search API puts the owner/repo pair.
    pub repository_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchIssuesResponse {
    pub items: Vec<SearchIssueItem>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PullRequestRef {
    pub sha: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PullRequestUser {
    pub login: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PullRequestDetail {
    pub number: u64,
    pub title: String,
    pub html_url: String,
    pub state: String,
    #[serde(default)]
    pub merged: bool,
    pub head: PullRequestRef,
    pub base: PullRequestRef,
    #[serde(default)]
    pub requested_reviewers: Vec<PullRequestUser>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CiState {
    Pending,
    Success,
    Failure,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct RepositorySummary {
    pub name: String,
    #[serde(rename(serialize = "fullName", deserialize = "full_name"))]
    pub full_name: String,
    #[serde(rename(serialize = "htmlUrl", deserialize = "html_url"))]
    pub html_url: String,
    pub private: bool,
    pub visibility: String,
    #[serde(rename(serialize = "sizeKb", deserialize = "size"))]
    pub size_kb: u64,
    #[serde(rename(serialize = "pushedAt", deserialize = "pushed_at"))]
    pub pushed_at: Option<String>,
    #[serde(rename(serialize = "defaultBranch", deserialize = "default_branch"))]
    pub default_branch: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CheckRun {
    status: String,
    conclusion: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CheckRunsResponse {
    check_runs: Vec<CheckRun>,
}

/// Folds a commit's check runs into one overall state: still running beats
/// everything (the truest answer is "not done yet"), otherwise any failed
/// run fails the whole build. GitHub Actions and any other app reporting
/// check runs are covered; the older, separate Statuses API (used by CI
/// systems that predate check runs) is not polled — see
/// docs/ARCHITECTURE.md's GitHub connector section.
fn overall_ci_state(check_runs: &[CheckRun]) -> Option<CiState> {
    if check_runs.is_empty() {
        return None;
    }
    if check_runs.iter().any(|r| r.status != "completed") {
        return Some(CiState::Pending);
    }
    let failed = check_runs.iter().any(|r| {
        matches!(
            r.conclusion.as_deref(),
            Some("failure") | Some("timed_out") | Some("cancelled")
        )
    });
    Some(if failed {
        CiState::Failure
    } else {
        CiState::Success
    })
}

#[allow(
    async_fn_in_trait,
    reason = "no dyn dispatch needed — poll:: is generic over C: GitHubClient, mirroring jobs::spawn's generic S: EventSink"
)]
pub trait GitHubClient: Clone + Send + Sync + 'static {
    async fn start_device_flow(&self, client_id: &str) -> Result<DeviceCodeResponse>;
    async fn poll_device_token(&self, client_id: &str, device_code: &str) -> Result<TokenResponse>;
    async fn refresh_token(&self, client_id: &str, refresh_token: &str) -> Result<TokenResponse>;
    async fn fetch_viewer_login(&self, token: &str) -> Result<String>;
    async fn search_involved_prs(
        &self,
        token: &str,
        username: &str,
        etag: Option<&str>,
    ) -> Result<Conditional<Vec<SearchIssueItem>>>;
    async fn list_repositories(&self, token: &str) -> Result<Vec<RepositorySummary>>;
    async fn fetch_pr(
        &self,
        token: &str,
        owner: &str,
        repo: &str,
        number: u64,
    ) -> Result<PullRequestDetail>;
    async fn fetch_ci_state(
        &self,
        token: &str,
        owner: &str,
        repo: &str,
        sha: &str,
    ) -> Result<Option<CiState>>;
}

#[derive(Clone)]
pub struct HttpGitHubClient(reqwest::Client);

impl Default for HttpGitHubClient {
    fn default() -> Self {
        Self(
            reqwest::Client::builder()
                .user_agent("relay-desktop")
                .build()
                .expect("the default reqwest TLS backend is always available"),
        )
    }
}

impl HttpGitHubClient {
    async fn authed_get(
        &self,
        token: &str,
        url: &str,
        etag: Option<&str>,
    ) -> Result<reqwest::Response> {
        let mut request = self
            .0
            .get(url)
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(etag) = etag {
            request = request.header("If-None-Match", etag);
        }
        request
            .send()
            .await
            .map_err(|e| Error::GithubRequestFailed(e.to_string()))
    }
}

/// Reads a response body and parses it as `T`, reporting the HTTP status and
/// a snippet of the body on failure rather than `reqwest`'s bare "error
/// decoding response body" — which is all `Response::json` gives you, and
/// tells you nothing about *why* (an HTML error page from a proxy in front
/// of `github.com`, an OAuth error object shaped nothing like the success
/// response, GitHub itself returning something unexpected). A wrong or
/// unregistered OAuth client id, in particular, surfaces exactly this way:
/// GitHub answers the device-code request with an error body that has none
/// of `DeviceCodeResponse`'s required fields.
async fn read_json<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| Error::GithubRequestFailed(e.to_string()))?;
    serde_json::from_str(&body).map_err(|e| {
        Error::GithubRequestFailed(format!(
            "GitHub returned {status} with a body Relay could not parse ({e}): {}",
            truncate(&body, 200)
        ))
    })
}

fn truncate(body: &str, max_chars: usize) -> String {
    let mut truncated: String = body.chars().take(max_chars).collect();
    if truncated.len() < body.len() {
        truncated.push('…');
    }
    truncated
}

impl GitHubClient for HttpGitHubClient {
    async fn start_device_flow(&self, client_id: &str) -> Result<DeviceCodeResponse> {
        let response = self
            .0
            .post("https://github.com/login/device/code")
            .header("Accept", "application/json")
            .form(&[("client_id", client_id), ("scope", super::oauth::SCOPE)])
            .send()
            .await
            .map_err(|e| Error::GithubRequestFailed(e.to_string()))?;
        read_json(response).await
    }

    async fn poll_device_token(&self, client_id: &str, device_code: &str) -> Result<TokenResponse> {
        let response = self
            .0
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|e| Error::GithubRequestFailed(e.to_string()))?;
        read_json(response).await
    }

    async fn refresh_token(&self, client_id: &str, refresh_token: &str) -> Result<TokenResponse> {
        let response = self
            .0
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id),
                ("refresh_token", refresh_token),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await
            .map_err(|e| Error::GithubRequestFailed(e.to_string()))?;
        read_json(response).await
    }

    async fn fetch_viewer_login(&self, token: &str) -> Result<String> {
        let response = self
            .authed_get(token, "https://api.github.com/user", None)
            .await?;
        #[derive(Deserialize)]
        struct User {
            login: String,
        }
        let user: User = read_json(response).await?;
        Ok(user.login)
    }

    async fn search_involved_prs(
        &self,
        token: &str,
        username: &str,
        etag: Option<&str>,
    ) -> Result<Conditional<Vec<SearchIssueItem>>> {
        // `involves:` covers authored, assigned, mentioned, commented-on and
        // review-requested PRs in one query — the broadest reading of "the
        // signed-in user's PRs across their repos" that still fits one call.
        let url = format!(
            "https://api.github.com/search/issues?q={}",
            urlencode(&format!("is:pr involves:{username}"))
        );
        let response = self.authed_get(token, &url, etag).await?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(Conditional::NotModified);
        }
        let new_etag = etag_header(&response);
        check_rate_limit(&response)?;
        let body: SearchIssuesResponse = read_json(response).await?;
        Ok(Conditional::Fresh {
            value: body.items,
            etag: new_etag,
        })
    }

    async fn list_repositories(&self, token: &str) -> Result<Vec<RepositorySummary>> {
        let response = self
            .authed_get(
                token,
                "https://api.github.com/user/repos?sort=pushed&direction=desc&per_page=30&affiliation=owner%2Ccollaborator%2Corganization_member",
                None,
            )
            .await?;
        check_rate_limit(&response)?;
        read_json(response).await
    }

    async fn fetch_pr(
        &self,
        token: &str,
        owner: &str,
        repo: &str,
        number: u64,
    ) -> Result<PullRequestDetail> {
        let url = format!("https://api.github.com/repos/{owner}/{repo}/pulls/{number}");
        let response = self.authed_get(token, &url, None).await?;
        check_rate_limit(&response)?;
        read_json(response).await
    }

    async fn fetch_ci_state(
        &self,
        token: &str,
        owner: &str,
        repo: &str,
        sha: &str,
    ) -> Result<Option<CiState>> {
        let url = format!("https://api.github.com/repos/{owner}/{repo}/commits/{sha}/check-runs");
        let response = self.authed_get(token, &url, None).await?;
        check_rate_limit(&response)?;
        let body: CheckRunsResponse = read_json(response).await?;
        Ok(overall_ci_state(&body.check_runs))
    }
}

fn etag_header(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

/// GitHub answers a rate-limited request with 403/429 and an
/// `X-RateLimit-Remaining: 0` (or a `Retry-After`) rather than a normal
/// error body. The poll loop treats this as "try again next cycle" instead
/// of a hard failure — see `poll::run_poll_cycle`.
fn check_rate_limit(response: &reqwest::Response) -> Result<()> {
    let status = response.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        return Err(Error::GithubRateLimited);
    }
    Ok(())
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b' ' => "+".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
pub mod fake {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// Scripted responses consumed in order (or by key), one per matching
    /// call — the same shape as the FakeSink pattern in `jobs::mod`, but for
    /// an API with several distinct calls instead of one `emit`. Consuming
    /// by ownership (`Vec::remove`/`HashMap::remove`) rather than cloning
    /// means `Error` never needs a `Clone` impl just for tests.
    type PrKey = (String, String, u64);
    type PrResponses = Arc<Mutex<std::collections::HashMap<PrKey, Result<PullRequestDetail>>>>;
    type CiStateResponses = Arc<Mutex<std::collections::HashMap<String, Result<Option<CiState>>>>>;
    type SearchResponses = Arc<Mutex<Vec<Result<Conditional<Vec<SearchIssueItem>>>>>>;
    type RepositoryResponses = Arc<Mutex<Vec<Result<Vec<RepositorySummary>>>>>;

    #[derive(Clone, Default)]
    pub struct FakeGitHubClient {
        pub device_code: Arc<Mutex<Vec<Result<DeviceCodeResponse>>>>,
        pub token_polls: Arc<Mutex<Vec<Result<TokenResponse>>>>,
        pub refreshes: Arc<Mutex<Vec<Result<TokenResponse>>>>,
        pub viewer_login: Arc<Mutex<Vec<Result<String>>>>,
        pub searches: SearchResponses,
        pub repositories: RepositoryResponses,
        pub prs: PrResponses,
        pub ci_states: CiStateResponses,
    }

    fn take<T>(queue: &Mutex<Vec<Result<T>>>) -> Result<T> {
        let mut queue = queue.lock().unwrap();
        if queue.is_empty() {
            panic!("fake GitHub client ran out of scripted responses");
        }
        queue.remove(0)
    }

    impl GitHubClient for FakeGitHubClient {
        async fn start_device_flow(&self, _client_id: &str) -> Result<DeviceCodeResponse> {
            take(&self.device_code)
        }

        async fn poll_device_token(
            &self,
            _client_id: &str,
            _device_code: &str,
        ) -> Result<TokenResponse> {
            take(&self.token_polls)
        }

        async fn refresh_token(
            &self,
            _client_id: &str,
            _refresh_token: &str,
        ) -> Result<TokenResponse> {
            take(&self.refreshes)
        }

        async fn fetch_viewer_login(&self, _token: &str) -> Result<String> {
            take(&self.viewer_login)
        }

        async fn search_involved_prs(
            &self,
            _token: &str,
            _username: &str,
            _etag: Option<&str>,
        ) -> Result<Conditional<Vec<SearchIssueItem>>> {
            take(&self.searches)
        }

        async fn list_repositories(&self, _token: &str) -> Result<Vec<RepositorySummary>> {
            take(&self.repositories)
        }

        async fn fetch_pr(
            &self,
            _token: &str,
            owner: &str,
            repo: &str,
            number: u64,
        ) -> Result<PullRequestDetail> {
            self.prs
                .lock()
                .unwrap()
                .remove(&(owner.to_string(), repo.to_string(), number))
                .expect("fake fetch_pr was not scripted for this pull request")
        }

        async fn fetch_ci_state(
            &self,
            _token: &str,
            owner: &str,
            repo: &str,
            sha: &str,
        ) -> Result<Option<CiState>> {
            self.ci_states
                .lock()
                .unwrap()
                .remove(&format!("{owner}/{repo}@{sha}"))
                .expect("fake fetch_ci_state was not scripted for this sha")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overall_ci_state_prefers_pending_over_any_completed_result() {
        let runs = vec![
            CheckRun {
                status: "completed".to_string(),
                conclusion: Some("success".to_string()),
            },
            CheckRun {
                status: "in_progress".to_string(),
                conclusion: None,
            },
        ];
        assert_eq!(overall_ci_state(&runs), Some(CiState::Pending));
    }

    #[test]
    fn overall_ci_state_is_failure_if_any_run_failed() {
        let runs = vec![
            CheckRun {
                status: "completed".to_string(),
                conclusion: Some("success".to_string()),
            },
            CheckRun {
                status: "completed".to_string(),
                conclusion: Some("failure".to_string()),
            },
        ];
        assert_eq!(overall_ci_state(&runs), Some(CiState::Failure));
    }

    #[test]
    fn overall_ci_state_is_success_when_everything_completed_cleanly() {
        let runs = vec![CheckRun {
            status: "completed".to_string(),
            conclusion: Some("success".to_string()),
        }];
        assert_eq!(overall_ci_state(&runs), Some(CiState::Success));
    }

    #[test]
    fn no_check_runs_is_not_known() {
        assert_eq!(overall_ci_state(&[]), None);
    }

    #[test]
    fn repository_summary_reads_the_fields_used_by_the_projects_surface() {
        let repository: RepositorySummary = serde_json::from_str(
            r#"{
                "name":"relay",
                "full_name":"openai/relay",
                "html_url":"https://github.com/openai/relay",
                "private":true,
                "visibility":"private",
                "size":2048,
                "pushed_at":"2026-09-21T10:00:00Z",
                "default_branch":"main"
            }"#,
        )
        .unwrap();
        assert_eq!(repository.full_name, "openai/relay");
        assert_eq!(repository.size_kb, 2048);
        assert_eq!(repository.visibility, "private");
    }

    #[test]
    fn urlencode_escapes_spaces_and_colons() {
        assert_eq!(
            urlencode("is:pr involves:octocat"),
            "is%3Apr+involves%3Aoctocat"
        );
    }

    #[test]
    fn truncate_leaves_short_bodies_untouched() {
        assert_eq!(truncate("short", 200), "short");
    }

    #[test]
    fn truncate_marks_a_cut_body_with_an_ellipsis() {
        let long = "a".repeat(300);
        let truncated = truncate(&long, 200);
        assert_eq!(truncated.chars().count(), 201);
        assert!(truncated.ends_with('…'));
    }

    fn http_response(status: u16, body: &str) -> reqwest::Response {
        http::Response::builder()
            .status(status)
            .body(body.as_bytes().to_vec())
            .unwrap()
            .into()
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct Ok200 {
        value: u32,
    }

    #[tokio::test]
    async fn read_json_parses_a_matching_body() {
        let response = http_response(200, r#"{"value":42}"#);
        let parsed: Ok200 = read_json(response).await.unwrap();
        assert_eq!(parsed, Ok200 { value: 42 });
    }

    #[tokio::test]
    async fn read_json_reports_the_status_and_body_on_a_shape_mismatch() {
        // What an invalid or unregistered OAuth client id actually produces:
        // a 200 whose body has none of the fields `DeviceCodeResponse` needs.
        let response = http_response(200, r#"{"error":"unauthorized_client"}"#);
        let result: Result<Ok200> = read_json(response).await;
        let message = result.unwrap_err().to_string();
        assert!(message.contains("200"), "message was: {message}");
        assert!(
            message.contains("unauthorized_client"),
            "message was: {message}"
        );
    }

    #[tokio::test]
    async fn read_json_reports_a_non_json_body_instead_of_a_bare_decode_error() {
        let response = http_response(502, "<html>Bad Gateway</html>");
        let result: Result<Ok200> = read_json(response).await;
        let message = result.unwrap_err().to_string();
        assert!(message.contains("502"), "message was: {message}");
        assert!(message.contains("Bad Gateway"), "message was: {message}");
    }
}
