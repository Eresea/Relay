mod common;

use std::sync::atomic::Ordering;
use std::time::Duration;

use common::*;
use nexus_client::{AuthState, ConnectionState, Error, EventsOptions, TokenStore};
use serde_json::{json, Value};

fn ev(seq: i64) -> Value {
    json!({"id":format!("e{seq}"),"seq":seq,"endpointId":"ep","deliveryId":"d","eventType":"push","payload":{"n":seq},"receivedAt":"t"})
}

fn fast() -> EventsOptions {
    EventsOptions {
        backoff_base: Duration::from_millis(20),
        backoff_max: Duration::from_millis(80),
        ping_interval: Duration::from_millis(100),
        inbox_limit: 2,
    }
}

fn ready() -> Step {
    Step::Text(json!({"type":"connection.ready","payload":{"userId":"u","sessionId":"sess-1"}}))
}

fn available(seq: i64) -> Step {
    Step::Text(json!({"type":"events.available","payload":{"eventId":"x","seq":seq}}))
}

#[tokio::test]
async fn connects_with_bearer_header_drains_and_acks_after_handler() {
    let s = start().await;
    s.mock.ws_scripts.lock().unwrap().push_back(vec![ready()]);
    // limit=2: page of 2 (full) then page of 1.
    s.mock
        .inbox_pages
        .lock()
        .unwrap()
        .extend([json!({"events":[ev(1), ev(2)]}), json!({"events":[ev(3)]})]);
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    let m = s.mock.clone();
    let h = c.events_with(
        move |e| {
            let m = m.clone();
            async move {
                m.log(format!("handle {}", e.seq));
                Ok::<_, std::convert::Infallible>(())
            }
        },
        fast(),
    );
    let mut conn = h.connection();
    conn.wait_for(
        |s| matches!(s, ConnectionState::Connected { session_id: Some(id) } if id == "sess-1"),
    )
    .await
    .unwrap();
    eventually("drain", || s.mock.count("POST /events/inbox/ack") == 2).await;
    assert_eq!(
        s.mock.entries(),
        vec![
            "WS connect Bearer access-0",
            "GET /events/inbox after=",
            "handle 1",
            "handle 2",
            "POST /events/inbox/ack upTo=2",
            "GET /events/inbox after=2",
            "handle 3",
            "POST /events/inbox/ack upTo=3",
        ]
    );
}

#[tokio::test]
async fn events_available_triggers_another_drain() {
    let s = start().await;
    s.mock
        .ws_scripts
        .lock()
        .unwrap()
        .push_back(vec![ready(), Step::Sleep(200), available(5)]);
    s.mock
        .inbox_pages
        .lock()
        .unwrap()
        .extend([json!({"events":[]}), json!({"events":[ev(5)]})]);
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    let _h = c.events_with(|_| async { Ok::<_, std::convert::Infallible>(()) }, fast());
    eventually("second drain acked", || {
        s.mock.count("POST /events/inbox/ack upTo=5") == 1
    })
    .await;
    assert_eq!(s.mock.count("GET /events/inbox"), 2);
}

#[tokio::test]
async fn failing_handler_is_not_acked_and_is_redelivered() {
    let s = start().await;
    s.mock.ws_scripts.lock().unwrap().push_back(vec![ready()]);
    s.mock
        .inbox_pages
        .lock()
        .unwrap()
        .extend([json!({"events":[ev(1), ev(2)]}), json!({"events":[ev(2)]})]);
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    let m = s.mock.clone();
    let _h = c.events_with(
        move |e| {
            let m = m.clone();
            async move {
                let first_try = m.count("handle 2") == 0;
                m.log(format!("handle {}", e.seq));
                if e.seq == 2 && first_try {
                    return Err("boom");
                }
                Ok(())
            }
        },
        fast(),
    );
    eventually("redelivery acked", || {
        s.mock.count("POST /events/inbox/ack upTo=2") == 1
    })
    .await;
    let log = s.mock.entries();
    let acks: Vec<_> = log
        .iter()
        .filter(|e| e.starts_with("POST /events/inbox/ack"))
        .collect();
    // Event 1 was acked alone; 2 only after its handler finally succeeded.
    assert_eq!(
        acks,
        [
            "POST /events/inbox/ack upTo=1",
            "POST /events/inbox/ack upTo=2"
        ]
    );
    let i_fail = log.iter().position(|e| e == "handle 2").unwrap();
    let i_ack2 = log
        .iter()
        .position(|e| e == "POST /events/inbox/ack upTo=2")
        .unwrap();
    assert!(i_fail < i_ack2);
}

#[tokio::test]
async fn drain_inbox_reports_handler_error_without_acking_it() {
    let s = start().await;
    s.mock
        .inbox_pages
        .lock()
        .unwrap()
        .push_back(json!({"events":[ev(1)]}));
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    let err = c
        .drain_inbox(|_| async { Err::<(), _>("nope".into()) })
        .await
        .unwrap_err();
    assert!(matches!(err, Error::Handler(m) if m == "nope"));
    assert_eq!(s.mock.count("POST /events/inbox/ack"), 0);
}

#[tokio::test]
async fn close_4001_signs_out() {
    let s = start().await;
    s.mock
        .ws_scripts
        .lock()
        .unwrap()
        .push_back(vec![ready(), Step::Close(4001)]);
    let (c, store) = client_with(&s, Some(session("access-0", 600)));
    let mut auth = c.watch();
    let h = c.events_with(|_| async { Ok::<_, std::convert::Infallible>(()) }, fast());
    auth.wait_for(|a| *a == AuthState::SignedOut).await.unwrap();
    assert!(store.load().unwrap().is_none());
    h.connection()
        .wait_for(|s| *s == ConnectionState::Stopped)
        .await
        .unwrap();
    assert_eq!(
        s.mock.count("WS connect"),
        1,
        "must not reconnect after revocation"
    );
}

#[tokio::test]
async fn session_revoked_event_signs_out() {
    let s = start().await;
    s.mock
        .ws_scripts
        .lock()
        .unwrap()
        .push_back(vec![ready(), Step::Text(json!({"type":"session.revoked"}))]);
    let (c, store) = client_with(&s, Some(session("access-0", 600)));
    let mut auth = c.watch();
    let _h = c.events_with(|_| async { Ok::<_, std::convert::Infallible>(()) }, fast());
    auth.wait_for(|a| *a == AuthState::SignedOut).await.unwrap();
    assert!(store.load().unwrap().is_none());
}

#[tokio::test]
async fn close_4002_refreshes_then_reconnects_with_new_token() {
    let s = start().await;
    s.mock
        .ws_scripts
        .lock()
        .unwrap()
        .push_back(vec![ready(), Step::Close(4002)]);
    s.mock.ws_scripts.lock().unwrap().push_back(vec![ready()]);
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    let h = c.events_with(|_| async { Ok::<_, std::convert::Infallible>(()) }, fast());
    eventually("reconnect", || s.mock.count("WS connect") == 2).await;
    assert_eq!(
        *s.mock.ws_auth.lock().unwrap(),
        ["Bearer access-0", "Bearer access-r1"]
    );
    assert_eq!(s.mock.refresh_calls.load(Ordering::SeqCst), 1);
    h.connection()
        .wait_for(|s| matches!(s, ConnectionState::Connected { .. }))
        .await
        .unwrap();
}

#[tokio::test]
async fn close_4002_with_dead_refresh_token_signs_out() {
    let s = start().await;
    *s.mock.refresh_fail.lock().unwrap() = Some((400, "invalid_grant"));
    s.mock
        .ws_scripts
        .lock()
        .unwrap()
        .push_back(vec![ready(), Step::Close(4002)]);
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    let mut auth = c.watch();
    let _h = c.events_with(|_| async { Ok::<_, std::convert::Infallible>(()) }, fast());
    auth.wait_for(|a| *a == AuthState::SignedOut).await.unwrap();
    assert_eq!(s.mock.count("WS connect"), 1);
}

#[tokio::test]
async fn dropped_connection_reconnects_with_backoff_and_redrains() {
    let s = start().await;
    s.mock
        .ws_scripts
        .lock()
        .unwrap()
        .push_back(vec![ready(), Step::Close(1011)]);
    s.mock
        .ws_scripts
        .lock()
        .unwrap()
        .push_back(vec![ready(), Step::Close(1011)]);
    s.mock.ws_scripts.lock().unwrap().push_back(vec![ready()]);
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    let started = std::time::Instant::now();
    let _h = c.events_with(|_| async { Ok::<_, std::convert::Infallible>(()) }, fast());
    eventually("3 connections", || s.mock.count("WS connect") == 3).await;
    // Still signed in, no token refresh needed, and every connect drains the inbox.
    assert!(matches!(c.auth_state(), AuthState::SignedIn { .. }));
    assert_eq!(s.mock.refresh_calls.load(Ordering::SeqCst), 0);
    eventually("drains", || s.mock.count("GET /events/inbox") >= 1).await;
    assert!(started.elapsed() >= Duration::from_millis(20));
}

#[tokio::test]
async fn connection_survives_several_ping_intervals() {
    let s = start().await;
    // Pings go out every 100 ms; an answering server keeps the connection up past 2.5 intervals.
    s.mock.ws_scripts.lock().unwrap().push_back(vec![ready()]);
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    let _h = c.events_with(|_| async { Ok::<_, std::convert::Infallible>(()) }, fast());
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(s.mock.count("WS connect"), 1);
}

#[tokio::test]
async fn dropping_the_handle_closes_the_socket_and_stops_reconnecting() {
    let s = start().await;
    s.mock.ws_scripts.lock().unwrap().push_back(vec![ready()]);
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    let h = c.events_with(|_| async { Ok::<_, std::convert::Infallible>(()) }, fast());
    eventually("connected", || s.mock.count("WS connect") == 1).await;
    h.stop();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(s.mock.count("WS connect"), 1);
}

#[tokio::test]
async fn null_events_from_the_server_mean_empty_inbox() {
    let s = start().await;
    s.mock
        .inbox_pages
        .lock()
        .unwrap()
        .push_back(json!({"events":null,"cursor":0}));
    let (c, _) = client_with(&s, Some(session("access-0", 600)));
    assert_eq!(c.drain_inbox(|_| async { Ok(()) }).await.unwrap(), 0);
}
