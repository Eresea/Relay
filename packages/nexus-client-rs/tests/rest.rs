mod common;

use common::*;
use nexus_client::{CredentialInput, Error, EventEndpointInput};
use serde_json::json;

fn signed_in(s: &Server) -> nexus_client::NexusClient {
    client_with(s, Some(session("access-0", 600))).0
}

#[tokio::test]
async fn create_and_list_granted() {
    let s = start().await;
    let conns = signed_in(&s).connections();
    let c = conns
        .create(&CredentialInput {
            namespace: "github".into(),
            credential_type: "oauth-token-bundle".into(),
            label: "GitHub".into(),
            metadata: json!({"u": 1}),
            secret: "tok".into(),
            expires_at: None,
        })
        .await
        .unwrap();
    assert_eq!(c.id, "cred-1");
    let body = s.mock.last_body.lock().unwrap().clone();
    assert_eq!(
        body,
        json!({"namespace":"github","type":"oauth-token-bundle","label":"GitHub","metadata":{"u":1},"secret":"tok"})
    );
    assert_eq!(
        s.mock.last_headers.lock().unwrap()["authorization"],
        "Bearer access-0"
    );
    assert_eq!(conns.granted().await.unwrap().len(), 1);
}

#[tokio::test]
async fn if_match_conflict_is_surfaced_and_retry_succeeds() {
    let s = start().await;
    *s.mock.secret_revision.lock().unwrap() = 7;
    let conns = signed_in(&s).connections();
    let first = conns.read_secret("cred-1").await.unwrap();
    assert_eq!(first.secret, "s3cret");
    assert_eq!(first.revision.as_deref(), Some("\"7\""));

    // Someone else replaces the secret in between.
    *s.mock.secret_revision.lock().unwrap() = 8;
    let err = conns
        .replace_secret("cred-1", "new", None, first.revision.as_deref())
        .await
        .unwrap_err();
    assert!(err.is_revision_conflict(), "{err:?}");

    let fresh = conns.read_secret("cred-1").await.unwrap();
    let rev = conns
        .replace_secret("cred-1", "new", None, fresh.revision.as_deref())
        .await
        .unwrap();
    assert_eq!(rev.as_deref(), Some("\"9\""));
    assert_eq!(s.mock.last_headers.lock().unwrap()["if-match"], "\"8\"");
    assert_eq!(
        s.mock.last_body.lock().unwrap().clone(),
        json!({"secret":"new","expiresAt":null})
    );
}

#[tokio::test]
async fn unconditional_replace_sends_no_if_match() {
    let s = start().await;
    let conns = signed_in(&s).connections();
    conns
        .replace_secret("cred-1", "x", Some("2030-01-01T00:00:00Z"), None)
        .await
        .unwrap();
    assert!(!s.mock.last_headers.lock().unwrap().contains_key("if-match"));
}

#[tokio::test]
async fn available_and_grant_request_opens_consent_url() {
    let s = start().await;
    let conns = signed_in(&s).connections();
    let avail = conns.available("github").await.unwrap();
    assert_eq!(avail[0].created_by.as_ref().unwrap().name, "Leaf");
    assert_eq!(s.mock.last_query.lock().unwrap()["type"], "github");

    let mut opened = None;
    let req = conns
        .request_grant("cred-2", true, |u| {
            opened = Some(u.to_string());
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(opened.as_deref(), Some(req.consent_url.as_str()));
    assert!(req.consent_url.ends_with("/consent/credentials/req-cred-2"));
    assert_eq!(
        s.mock.last_body.lock().unwrap().clone(),
        json!({"canReplace":true})
    );

    let err = conns
        .request_grant("cred-2", false, |_| Err("no opener".into()))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::Opener(_)));
}

#[tokio::test]
async fn event_endpoints_create_list_revoke() {
    let s = start().await;
    let eps = signed_in(&s).event_endpoints();
    let created = eps
        .create(&EventEndpointInput {
            signature_mode: Some("raw-body".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        (
            created.endpoint_id.as_str(),
            created.signing_secret.as_str()
        ),
        ("ep-1", "sig")
    );
    assert_eq!(
        s.mock.last_body.lock().unwrap().clone(),
        json!({"signatureMode":"raw-body"})
    );
    assert_eq!(eps.list().await.unwrap()[0].client_id, "relay");
    eps.revoke("ep-1").await.unwrap();
    assert_eq!(
        s.mock.entries(),
        vec!["DELETE /events/endpoints/ep-1".to_string()]
    );
}

#[tokio::test]
async fn push_registers_device_with_client_id_as_app_id() {
    let s = start().await;
    let push = signed_in(&s).push();
    push.register("fcm-token", "android", Some("Pixel"))
        .await
        .unwrap();
    assert_eq!(
        s.mock.last_body.lock().unwrap().clone(),
        json!({"appId":"relay","platform":"android","token":"fcm-token","label":"Pixel"})
    );
    push.unregister("fcm-token").await.unwrap();
    assert_eq!(
        s.mock.last_body.lock().unwrap().clone(),
        json!({"token":"fcm-token"})
    );
}

#[tokio::test]
async fn api_calls_require_sign_in() {
    let s = start().await;
    let (c, _) = client_with(&s, None);
    assert!(matches!(
        c.connections().granted().await,
        Err(Error::NotSignedIn)
    ));
}
