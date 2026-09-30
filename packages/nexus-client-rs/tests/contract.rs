//! Contract tests against a live Nexus. Ignored by default; see README "Contract tests".
//!
//!   NEXUS_CONTRACT_ISSUER=http://127.0.0.1:18412/api/v1 \
//!   NEXUS_CONTRACT_EMAIL=sdk@example.com NEXUS_CONTRACT_PASSWORD=... \
//!   cargo test --test contract -- --ignored --test-threads=1
//!
//! The Nexus must load a `relay` native client (deploy/clients.yaml) and the user must be verified.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use nexus_client::{
    AuthState, ConnectionState, CredentialInput, EventEndpointInput, MemoryTokenStore, NexusClient,
    NexusConfig, TokenStore,
};
use serde_json::json;
use url::Url;

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("set {k} to run contract tests"))
}

fn config() -> NexusConfig {
    NexusConfig {
        issuer: env("NEXUS_CONTRACT_ISSUER"),
        client_id: "relay".into(),
        redirect_uri: "relay://auth/callback".into(),
        scopes: ["openid", "profile", "email", "connections"]
            .map(String::from)
            .to_vec(),
        keyring_service: "nexus-client-contract".into(),
        keyring_account: "test".into(),
    }
}

/// Plays the browser: follows the hosted sign-in page and returns the `relay://` callback URL.
async fn hosted_login(authorize_url: &str) -> String {
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let mut jar: HashMap<String, String> = HashMap::new();
    let mut url = Url::parse(authorize_url).unwrap();
    let mut form: Option<Vec<(String, String)>> = None;
    for _ in 0..8 {
        let cookie = jar
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        let req = match form.take() {
            Some(f) => http.post(url.clone()).form(&f),
            None => http.get(url.clone()),
        };
        let resp = req.header("cookie", cookie).send().await.unwrap();
        for c in resp.headers().get_all("set-cookie") {
            let kv = c.to_str().unwrap().split(';').next().unwrap();
            let (k, v) = kv.split_once('=').unwrap();
            jar.insert(k.into(), v.into());
        }
        if let Some(loc) = resp.headers().get("location") {
            let loc = loc.to_str().unwrap();
            if loc.starts_with("relay://") {
                return loc.to_string();
            }
            url = url.join(loc).unwrap();
            continue;
        }
        let page = resp.text().await.unwrap();
        let field = |name: &str| {
            let marker = format!("name=\"{name}\" value=\"");
            let i = page
                .find(&marker)
                .unwrap_or_else(|| panic!("no {name} in page:\n{page}"))
                + marker.len();
            page[i..].split('"').next().unwrap().to_string()
        };
        form = Some(vec![
            ("flow".into(), field("flow")),
            ("csrf".into(), field("csrf")),
            ("email".into(), env("NEXUS_CONTRACT_EMAIL")),
            ("password".into(), env("NEXUS_CONTRACT_PASSWORD")),
        ]);
        url = url.join("/").unwrap();
        url.set_path("/api/v1/oauth/login");
        url.set_query(None);
    }
    panic!("hosted login did not reach the callback");
}

async fn sign_in() -> (NexusClient, Arc<MemoryTokenStore>) {
    let store = Arc::new(MemoryTokenStore::new());
    let client = NexusClient::new(config(), store.clone() as Arc<dyn TokenStore>).unwrap();
    let mut authorize = String::new();
    client
        .sign_in(|u| {
            authorize = u.into();
            Ok(())
        })
        .unwrap();
    client
        .handle_callback(&hosted_login(&authorize).await)
        .await
        .unwrap();
    (client, store)
}

#[tokio::test]
#[ignore = "needs a live Nexus"]
async fn sign_in_userinfo_refresh_grace_and_revoke() {
    let (client, store) = sign_in().await;
    let user = client.user().await.unwrap().unwrap();
    assert_eq!(
        user.email.as_deref(),
        Some(env("NEXUS_CONTRACT_EMAIL").as_str())
    );

    // Concurrent refresh on an expired access token: one rotation, everyone gets the same token.
    let mut s = store.load().unwrap().unwrap();
    let original_refresh = s.refresh_token.clone();
    s.expires_at = 0;
    let store2 = Arc::new(MemoryTokenStore::with_session(s));
    let c2 = NexusClient::new(config(), store2.clone() as Arc<dyn TokenStore>).unwrap();
    let tokens: Vec<_> = futures_util::future::join_all((0..10).map(|_| c2.access_token())).await;
    let first = tokens[0].as_ref().unwrap();
    assert!(tokens.iter().all(|t| t.as_ref().unwrap() == first));
    let rotated = store2.load().unwrap().unwrap().refresh_token;
    assert_ne!(rotated, original_refresh);

    // D6: replaying the pre-rotation refresh token within 30 s returns the same successor.
    let mut stale = store2.load().unwrap().unwrap();
    stale.refresh_token = original_refresh.clone();
    stale.expires_at = 0;
    let c3 = NexusClient::new(
        config(),
        Arc::new(MemoryTokenStore::with_session(stale.clone())) as Arc<dyn TokenStore>,
    )
    .unwrap();
    c3.access_token().await.unwrap();

    // App sign-out revokes the session: its refresh token is dead afterwards.
    c2.sign_out(false).await.unwrap();
    assert_eq!(c2.auth_state(), AuthState::SignedOut);
    let dead = NexusClient::new(
        config(),
        Arc::new(MemoryTokenStore::with_session(stale)) as Arc<dyn TokenStore>,
    )
    .unwrap();
    let r = dead.access_token().await;
    assert!(r.as_ref().is_err_and(|e| e.is_signed_out()), "{r:?}");
    assert_eq!(dead.auth_state(), AuthState::SignedOut);
    client.sign_out(false).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live Nexus"]
async fn connections_if_match_and_event_endpoints() {
    let (client, _) = sign_in().await;
    let conns = client.connections();
    let created = conns
        .create(&CredentialInput {
            namespace: "github".into(),
            credential_type: "oauth-token-bundle".into(),
            label: "SDK contract".into(),
            metadata: json!({"username": "sdk"}),
            secret: "v1".into(),
            expires_at: None,
        })
        .await
        .unwrap();
    assert!(conns
        .granted()
        .await
        .unwrap()
        .iter()
        .any(|c| c.id == created.id));

    let read = conns.read_secret(&created.id).await.unwrap();
    assert_eq!(read.secret, "v1");
    let rev = read.revision.clone().expect("etag");
    let next = conns
        .replace_secret(&created.id, "v2", None, Some(&rev))
        .await
        .unwrap();
    assert!(next.is_some());
    // Stale revision: conflict is the retry signal.
    let err = conns
        .replace_secret(&created.id, "v3", None, Some(&rev))
        .await
        .unwrap_err();
    assert!(err.is_revision_conflict(), "{err:?}");
    assert_eq!(conns.read_secret(&created.id).await.unwrap().secret, "v2");
    conns.available("github").await.unwrap();

    let eps = client.event_endpoints();
    let ep = eps.create(&EventEndpointInput::default()).await.unwrap();
    assert!(eps
        .list()
        .await
        .unwrap()
        .iter()
        .any(|e| e.id == ep.endpoint_id));
    eps.revoke(&ep.endpoint_id).await.unwrap();
    client.sign_out(false).await.unwrap();
}

#[tokio::test]
#[ignore = "needs a live Nexus"]
async fn websocket_connects_drains_and_reacts_to_remote_sign_out_everywhere() {
    let (a, _) = sign_in().await;
    assert_eq!(a.drain_inbox(|_| async { Ok(()) }).await.unwrap(), 0);
    let h = a.events(|_| async { Ok::<_, std::convert::Infallible>(()) });
    let mut conn = h.connection();
    tokio::time::timeout(
        Duration::from_secs(10),
        conn.wait_for(|s| {
            matches!(
                s,
                ConnectionState::Connected {
                    session_id: Some(_)
                }
            )
        }),
    )
    .await
    .expect("connection.ready")
    .unwrap();

    // Another installation signs out everywhere -> this session is revoked over the socket.
    let (b, _) = sign_in().await;
    let mut auth = a.watch();
    b.sign_out(true).await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(10),
        auth.wait_for(|s| *s == AuthState::SignedOut),
    )
    .await
    .expect("session.revoked / 4001")
    .unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        conn.wait_for(|s| *s == ConnectionState::Stopped),
    )
    .await
    .unwrap()
    .unwrap();
}
