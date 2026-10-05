#![allow(dead_code)]
//! In-process mock of the Nexus endpoints the SDK uses (HTTP + WebSocket).

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Form, Json, Router};
use nexus_client::{MemoryTokenStore, NexusClient, NexusConfig, StoredSession, TokenStore};
use serde_json::{json, Value};

pub enum Step {
    Text(Value),
    Close(u16),
    Sleep(u64),
}

#[derive(Default)]
pub struct Mock {
    /// Ordered record of everything interesting, for ordering assertions.
    pub log: Mutex<Vec<String>>,
    pub token_forms: Mutex<Vec<HashMap<String, String>>>,
    pub refresh_calls: AtomicUsize,
    pub refresh_delay_ms: AtomicUsize,
    pub refresh_expires_in: Mutex<Option<u64>>,
    pub refresh_fail: Mutex<Option<(u16, &'static str)>>,
    /// Bearer tokens that get a 401 on API calls.
    pub reject_tokens: Mutex<Vec<String>>,
    pub ws_scripts: Mutex<VecDeque<Vec<Step>>>,
    pub ws_auth: Mutex<Vec<String>>,
    pub inbox_pages: Mutex<VecDeque<Value>>,
    pub secret_revision: Mutex<u64>,
    pub last_body: Mutex<Value>,
    pub last_query: Mutex<HashMap<String, String>>,
    pub last_headers: Mutex<HashMap<String, String>>,
}

impl Mock {
    pub fn log(&self, s: impl Into<String>) {
        self.log.lock().unwrap().push(s.into());
    }
    pub fn entries(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
    pub fn count(&self, prefix: &str) -> usize {
        self.entries()
            .iter()
            .filter(|e| e.starts_with(prefix))
            .count()
    }
}

type S = State<Arc<Mock>>;

fn bearer(h: &HeaderMap) -> String {
    h.get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim_start_matches("Bearer ")
        .to_string()
}

fn unauthorized(m: &Mock, h: &HeaderMap) -> bool {
    let t = bearer(h);
    t.is_empty() || m.reject_tokens.lock().unwrap().contains(&t)
}

fn err(status: u16, code: &str) -> axum::response::Response {
    (
        StatusCode::from_u16(status).unwrap(),
        Json(json!({ "error": code })),
    )
        .into_response()
}

async fn token(State(m): S, Form(form): Form<HashMap<String, String>>) -> axum::response::Response {
    m.token_forms.lock().unwrap().push(form.clone());
    match form.get("grant_type").map(String::as_str) {
        Some("authorization_code") => {
            m.log("POST /oauth/token authorization_code");
            if form.get("code").map(String::as_str) != Some("good-code") {
                return err(400, "invalid_grant");
            }
            Json(json!({"access_token":"access-1","refresh_token":"refresh-1","expires_in":600,"token_type":"Bearer"})).into_response()
        }
        Some("refresh_token") => {
            let n = m.refresh_calls.fetch_add(1, Ordering::SeqCst) + 1;
            m.log(format!(
                "POST /oauth/token refresh_token {}",
                form["refresh_token"]
            ));
            let delay = m.refresh_delay_ms.load(Ordering::SeqCst) as u64;
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            if let Some((status, code)) = *m.refresh_fail.lock().unwrap() {
                return err(status, code);
            }
            let exp = m.refresh_expires_in.lock().unwrap().unwrap_or(600);
            Json(json!({"access_token":format!("access-r{n}"),"refresh_token":format!("refresh-r{n}"),"expires_in":exp})).into_response()
        }
        _ => err(400, "unsupported_grant_type"),
    }
}

async fn userinfo(State(m): S, h: HeaderMap) -> axum::response::Response {
    if unauthorized(&m, &h) {
        m.log(format!("GET /oauth/userinfo 401 {}", bearer(&h)));
        return err(401, "unauthorized");
    }
    m.log(format!("GET /oauth/userinfo {}", bearer(&h)));
    Json(json!({"sub":"user-1","email":"a@b.c","name":"Ann"})).into_response()
}

async fn revoke(State(m): S, Form(f): Form<HashMap<String, String>>) -> Json<Value> {
    m.log(format!(
        "POST /oauth/revoke token={} client_id={}",
        f["token"], f["client_id"]
    ));
    Json(json!({}))
}

async fn logout_all(State(m): S, h: HeaderMap) -> axum::response::Response {
    m.log(format!("POST /auth/logout-all {}", bearer(&h)));
    Json(json!({"status":"logged_out"})).into_response()
}

async fn inbox(
    State(m): S,
    h: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> axum::response::Response {
    if unauthorized(&m, &h) {
        return err(401, "unauthorized");
    }
    m.log(format!(
        "GET /events/inbox after={}",
        q.get("after").cloned().unwrap_or_default()
    ));
    let page = m
        .inbox_pages
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or(json!({"events":[]}));
    Json(page).into_response()
}

async fn inbox_ack(State(m): S, Json(b): Json<Value>) -> Json<Value> {
    m.log(format!("POST /events/inbox/ack upTo={}", b["upTo"]));
    Json(json!({"cursor": b["upTo"]}))
}

async fn ws(State(m): S, h: HeaderMap, up: WebSocketUpgrade) -> axum::response::Response {
    let auth = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    m.ws_auth.lock().unwrap().push(auth.clone());
    m.log(format!("WS connect {auth}"));
    let script = m.ws_scripts.lock().unwrap().pop_front().unwrap_or_default();
    up.on_upgrade(move |sock| run_ws(sock, script))
}

async fn run_ws(mut sock: WebSocket, script: Vec<Step>) {
    for step in script {
        match step {
            Step::Text(v) => {
                let _ = sock.send(Message::Text(v.to_string())).await;
            }
            Step::Sleep(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            Step::Close(code) => {
                let _ = sock
                    .send(Message::Close(Some(CloseFrame {
                        code,
                        reason: "".into(),
                    })))
                    .await;
                return;
            }
        }
    }
    // Hold open until the client goes away (recv also answers pings).
    while let Some(Ok(_)) = sock.recv().await {}
}

async fn record(m: &Mock, h: &HeaderMap, q: HashMap<String, String>, body: Value) {
    *m.last_body.lock().unwrap() = body;
    *m.last_query.lock().unwrap() = q;
    *m.last_headers.lock().unwrap() = h
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
}

async fn cred_create(State(m): S, h: HeaderMap, Json(b): Json<Value>) -> axum::response::Response {
    record(&m, &h, Default::default(), b).await;
    (StatusCode::CREATED, Json(json!({"id":"cred-1","namespace":"github","type":"oauth-token-bundle","label":"GitHub","metadata":{"u":1},"createdAt":"t","updatedAt":"t","createdByClientId":"relay"}))).into_response()
}

async fn cred_available(
    State(m): S,
    h: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    record(&m, &h, q, Value::Null).await;
    Json(
        json!({"credentials":[{"id":"cred-2","namespace":"github","type":"github","label":"GH","createdBy":{"clientId":"leaf","name":"Leaf"},"createdAt":"t"}]}),
    )
}

async fn cred_granted() -> Json<Value> {
    Json(
        json!({"credentials":[{"id":"cred-1","namespace":"github","type":"x","label":"L","metadata":{},"createdAt":"t","updatedAt":"t"}]}),
    )
}

async fn secret_get(State(m): S, Path(id): Path<String>) -> axum::response::Response {
    let rev = *m.secret_revision.lock().unwrap();
    (
        [("etag", format!("\"{rev}\""))],
        Json(json!({"credentialId":id,"secret":"s3cret"})),
    )
        .into_response()
}

async fn secret_put(State(m): S, h: HeaderMap, Json(b): Json<Value>) -> axum::response::Response {
    record(&m, &h, Default::default(), b).await;
    let current = *m.secret_revision.lock().unwrap();
    if let Some(v) = h.get("if-match").and_then(|v| v.to_str().ok()) {
        if v.trim_matches('"') != current.to_string() {
            return err(409, "credential_revision_conflict");
        }
    }
    let next = current + 1;
    *m.secret_revision.lock().unwrap() = next;
    (StatusCode::NO_CONTENT, [("etag", format!("\"{next}\""))]).into_response()
}

async fn cred_delete(
    State(m): S,
    h: HeaderMap,
    Path(id): Path<String>,
) -> axum::response::Response {
    record(&m, &h, Default::default(), Value::Null).await;
    m.log(format!("delete {id}"));
    if id == "cred-1" {
        StatusCode::NO_CONTENT.into_response()
    } else {
        (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))).into_response()
    }
}

async fn grant_request(
    State(m): S,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(b): Json<Value>,
) -> axum::response::Response {
    record(&m, &h, Default::default(), b).await;
    (StatusCode::CREATED, Json(json!({"requestId":"req-1","consentUrl":format!("https://nexus.test/api/v1/consent/credentials/req-{id}"),"expiresAt":"t"}))).into_response()
}

async fn ep_create(State(m): S, h: HeaderMap, Json(b): Json<Value>) -> axum::response::Response {
    record(&m, &h, Default::default(), b).await;
    (
        StatusCode::CREATED,
        Json(json!({"endpointId":"ep-1","signingSecret":"sig"})),
    )
        .into_response()
}

async fn ep_list() -> Json<Value> {
    Json(
        json!({"endpoints":[{"id":"ep-1","clientId":"relay","signatureMode":"hmac","createdAt":"t"}]}),
    )
}

async fn ep_revoke(State(m): S, Path(id): Path<String>) -> StatusCode {
    m.log(format!("DELETE /events/endpoints/{id}"));
    StatusCode::NO_CONTENT
}

async fn push_register(
    State(m): S,
    h: HeaderMap,
    Json(b): Json<Value>,
) -> axum::response::Response {
    record(&m, &h, Default::default(), b).await;
    (StatusCode::CREATED, Json(json!({"id":"dev-1"}))).into_response()
}

pub struct Server {
    pub mock: Arc<Mock>,
    pub issuer: String,
}

pub async fn start() -> Server {
    let mock = Arc::new(Mock::default());
    let api = Router::new()
        .route("/oauth/token", post(token))
        .route("/oauth/userinfo", get(userinfo))
        .route("/oauth/revoke", post(revoke))
        .route("/auth/logout-all", post(logout_all))
        .route("/events/inbox", get(inbox))
        .route("/events/inbox/ack", post(inbox_ack))
        .route("/credentials", post(cred_create))
        .route("/credentials/granted", get(cred_granted))
        .route("/credentials/available", get(cred_available))
        .route("/credentials/:id", delete(cred_delete))
        .route("/credentials/:id/secret", get(secret_get).put(secret_put))
        .route("/credentials/:id/grant-requests", post(grant_request))
        .route("/events/endpoints", post(ep_create).get(ep_list))
        .route("/events/endpoints/:id", delete(ep_revoke))
        .route(
            "/notifications/devices",
            post(push_register).delete(push_register),
        );
    let app = Router::new()
        .nest("/api/v1", api)
        .route("/ws/v1/user", get(ws))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        mock,
        issuer: format!("http://{addr}/api/v1"),
    }
}

pub fn config(issuer: &str) -> NexusConfig {
    NexusConfig {
        issuer: issuer.into(),
        client_id: "relay".into(),
        redirect_uri: "relay://auth/callback".into(),
        scopes: vec![
            "openid".into(),
            "profile".into(),
            "email".into(),
            "connections".into(),
        ],
        keyring_service: "test".into(),
        keyring_account: "test".into(),
    }
}

pub fn session(access: &str, expires_in_secs: i64) -> StoredSession {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    StoredSession {
        access_token: access.into(),
        refresh_token: "refresh-0".into(),
        expires_at: (now + expires_in_secs) as u64,
        user: None,
    }
}

/// A client with a stored session; returns the store too for inspection.
pub fn client_with(
    server: &Server,
    s: Option<StoredSession>,
) -> (NexusClient, Arc<MemoryTokenStore>) {
    let store = Arc::new(match s {
        Some(s) => MemoryTokenStore::with_session(s),
        None => MemoryTokenStore::new(),
    });
    let c = NexusClient::new(config(&server.issuer), store.clone() as Arc<dyn TokenStore>).unwrap();
    (c, store)
}

pub async fn eventually<F: Fn() -> bool>(what: &str, f: F) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}
