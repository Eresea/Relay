mod common;

use std::sync::atomic::Ordering;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use common::*;
use nexus_client::{AuthState, Error, TokenStore};
use sha2::{Digest, Sha256};
use url::Url;

fn query(u: &str) -> std::collections::HashMap<String, String> {
    Url::parse(u).unwrap().query_pairs().into_owned().collect()
}

#[tokio::test]
async fn sign_in_builds_pkce_authorize_url() {
    let s = start().await;
    let (c, _) = client_with(&s, None);
    let mut opened = String::new();
    let pending = c
        .sign_in_with_prompt(Some("none"), |u| {
            opened = u.to_string();
            Ok(())
        })
        .unwrap();
    assert_eq!(opened, pending.authorize_url);
    assert!(opened.starts_with(&format!("{}/oauth/authorize?", s.issuer)));
    let q = query(&opened);
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["client_id"], "relay");
    assert_eq!(q["redirect_uri"], "relay://auth/callback");
    assert_eq!(q["scope"], "openid profile email connections");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["prompt"], "none");
    assert_eq!(q["state"], pending.state);
    assert!(q["state"].len() >= 32 && q["code_challenge"].len() == 43);
}

#[tokio::test]
async fn opener_failure_clears_pending() {
    let s = start().await;
    let (c, _) = client_with(&s, None);
    let err = c.sign_in(|_| Err("no browser".into())).unwrap_err();
    assert!(matches!(err, Error::Opener(m) if m == "no browser"));
    let cb = "relay://auth/callback?code=good-code&state=x";
    assert!(matches!(
        c.handle_callback(cb).await,
        Err(Error::NoPendingSignIn)
    ));
}

#[tokio::test]
async fn callback_validates_state_and_exchanges_code_with_verifier() {
    let s = start().await;
    let (c, store) = client_with(&s, None);
    let mut rx = c.watch();
    assert_eq!(c.auth_state(), AuthState::SignedOut);
    let pending = c.sign_in(|_| Ok(())).unwrap();
    let challenge = query(&pending.authorize_url)["code_challenge"].clone();

    // Wrong redirect, wrong state: rejected, and the pending attempt survives.
    assert!(matches!(
        c.handle_callback("other://auth/callback?code=good-code&state=x")
            .await,
        Err(Error::InvalidCallback)
    ));
    assert!(matches!(
        c.handle_callback("relay://auth/callback?code=good-code&state=forged")
            .await,
        Err(Error::StateMismatch)
    ));
    assert_eq!(s.mock.count("POST /oauth/token"), 0);

    c.handle_callback(&format!(
        "relay://auth/callback?code=good-code&state={}",
        pending.state
    ))
    .await
    .unwrap();

    let form = s.mock.token_forms.lock().unwrap()[0].clone();
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(form["client_id"], "relay");
    assert_eq!(form["redirect_uri"], "relay://auth/callback");
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(form["code_verifier"].as_bytes())),
        challenge
    );

    rx.changed().await.unwrap();
    assert!(matches!(c.auth_state(), AuthState::SignedIn { user: Some(u) } if u.sub == "user-1"));
    let saved = store.load().unwrap().unwrap();
    assert_eq!(
        (saved.access_token.as_str(), saved.refresh_token.as_str()),
        ("access-1", "refresh-1")
    );
    assert_eq!(c.access_token().await.unwrap(), "access-1");

    // The attempt is single use.
    let replay = format!(
        "relay://auth/callback?code=good-code&state={}",
        pending.state
    );
    assert!(matches!(
        c.handle_callback(&replay).await,
        Err(Error::NoPendingSignIn)
    ));
}

#[tokio::test]
async fn callback_error_param_surfaces_authorization_error() {
    let s = start().await;
    let (c, _) = client_with(&s, None);
    let p = c.sign_in(|_| Ok(())).unwrap();
    let err = c
        .handle_callback(&format!(
            "relay://auth/callback?error=login_required&state={}",
            p.state
        ))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::Authorization { code, .. } if code == "login_required"));
    assert_eq!(c.auth_state(), AuthState::SignedOut);
}

#[tokio::test]
async fn rejected_code_exchange_is_an_error_and_does_not_sign_in() {
    let s = start().await;
    let (c, store) = client_with(&s, None);
    let p = c.sign_in(|_| Ok(())).unwrap();
    let err = c
        .handle_callback(&format!("relay://auth/callback?code=bad&state={}", p.state))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::Api { status: 400, code, .. } if code == "invalid_grant"));
    assert!(store.load().unwrap().is_none());
}

#[tokio::test]
async fn fresh_token_is_returned_without_refresh_and_expiring_token_refreshes_early() {
    let s = start().await;
    let (c, store) = client_with(&s, Some(session("access-0", 600)));
    assert_eq!(c.access_token().await.unwrap(), "access-0");
    assert_eq!(s.mock.refresh_calls.load(Ordering::SeqCst), 0);

    // 20 s left is inside the 30 s early-renewal window.
    let (c, store2) = client_with(&s, Some(session("access-0", 20)));
    assert_eq!(c.access_token().await.unwrap(), "access-r1");
    let saved = store2.load().unwrap().unwrap();
    assert_eq!(saved.refresh_token, "refresh-r1");
    assert!(store.load().unwrap().unwrap().access_token == "access-0");
}

#[tokio::test]
async fn concurrent_refreshes_are_single_flight() {
    let s = start().await;
    s.mock.refresh_delay_ms.store(150, Ordering::SeqCst);
    let (c, _) = client_with(&s, Some(session("access-0", -5)));
    let tasks: Vec<_> = (0..25)
        .map(|_| {
            let c = c.clone();
            tokio::spawn(async move { c.access_token().await.unwrap() })
        })
        .collect();
    for t in tasks {
        assert_eq!(t.await.unwrap(), "access-r1");
    }
    assert_eq!(s.mock.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(s.mock.count("POST /oauth/token refresh_token refresh-0"), 1);
}

#[tokio::test]
async fn invalid_grant_signs_out_and_clears_store() {
    let s = start().await;
    *s.mock.refresh_fail.lock().unwrap() = Some((400, "invalid_grant"));
    let (c, store) = client_with(&s, Some(session("access-0", -5)));
    let mut rx = c.watch();
    assert!(matches!(c.auth_state(), AuthState::SignedIn { .. }));
    assert!(matches!(c.access_token().await, Err(Error::SignedOut)));
    rx.changed().await.unwrap();
    assert_eq!(*rx.borrow(), AuthState::SignedOut);
    assert!(store.load().unwrap().is_none());
    assert!(matches!(c.access_token().await, Err(Error::NotSignedIn)));
}

#[tokio::test]
async fn transient_refresh_failure_keeps_the_session() {
    let s = start().await;
    *s.mock.refresh_fail.lock().unwrap() = Some((503, "temporarily_unavailable"));
    let (c, store) = client_with(&s, Some(session("access-0", -5)));
    assert!(matches!(
        c.access_token().await,
        Err(Error::Api { status: 503, .. })
    ));
    assert!(matches!(c.auth_state(), AuthState::SignedIn { .. }));
    assert!(store.load().unwrap().is_some());
    *s.mock.refresh_fail.lock().unwrap() = None;
    assert_eq!(c.access_token().await.unwrap(), "access-r2");
}

#[tokio::test]
async fn unauthorized_api_call_refreshes_once_and_retries() {
    let s = start().await;
    s.mock.reject_tokens.lock().unwrap().push("access-0".into());
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    let user = c.user().await.unwrap().unwrap();
    assert_eq!(user.sub, "user-1");
    assert_eq!(
        s.mock.entries(),
        vec![
            "GET /oauth/userinfo 401 access-0".to_string(),
            "POST /oauth/token refresh_token refresh-0".into(),
            "GET /oauth/userinfo access-r1".into(),
        ]
    );
}

#[tokio::test]
async fn sign_out_revokes_refresh_token_then_clears_keychain() {
    let s = start().await;
    let (c, store) = client_with(&s, Some(session("access-0", 600)));
    c.sign_out(false).await.unwrap();
    assert_eq!(
        s.mock.entries(),
        vec!["POST /oauth/revoke token=refresh-0 client_id=relay".to_string()]
    );
    assert!(store.load().unwrap().is_none());
    assert_eq!(c.auth_state(), AuthState::SignedOut);
}

#[tokio::test]
async fn sign_out_everywhere_calls_logout_all_with_bearer() {
    let s = start().await;
    let (c, store) = client_with(&s, Some(session("access-0", 600)));
    c.sign_out(true).await.unwrap();
    assert_eq!(
        s.mock.entries(),
        vec!["POST /auth/logout-all access-0".to_string()]
    );
    assert!(store.load().unwrap().is_none());
}

#[tokio::test]
async fn sign_out_clears_local_state_even_if_server_is_unreachable() {
    let s = start().await;
    let (c, store) = client_with(&s, Some(session("access-0", 600)));
    // Point at a dead port by rebuilding with the same store.
    let mut cfg = config("http://127.0.0.1:1/api/v1");
    cfg.client_id = "relay".into();
    let dead = nexus_client::NexusClient::new(cfg, store.clone() as std::sync::Arc<dyn TokenStore>)
        .unwrap();
    assert!(matches!(dead.sign_out(false).await, Err(Error::Http(_))));
    assert!(store.load().unwrap().is_none());
    assert_eq!(dead.auth_state(), AuthState::SignedOut);
    drop(c);
}

#[tokio::test]
async fn stored_session_is_loaded_on_construction() {
    let s = start().await;
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    assert!(matches!(c.auth_state(), AuthState::SignedIn { user: None }));
}
