use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde::Deserialize;
use tokio::sync::{watch, Notify};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::client::NexusClient;
use crate::error::{BoxError, Error, Result};
use crate::inbox::InboxEvent;

const CLOSE_REVOKED: u16 = 4001;
const CLOSE_EXPIRED: u16 = 4002;

#[derive(Debug, Clone)]
pub struct EventsOptions {
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// Client ping interval; the connection is dropped after 2.5 intervals of silence.
    pub ping_interval: Duration,
    pub inbox_limit: u32,
}

impl Default for EventsOptions {
    fn default() -> Self {
        Self {
            backoff_base: Duration::from_millis(500),
            backoff_max: Duration::from_secs(30),
            ping_interval: Duration::from_secs(30),
            inbox_limit: 50,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    Connecting,
    Connected {
        session_id: Option<String>,
    },
    Disconnected,
    /// Signed out or stopped; the task has ended.
    Stopped,
}

/// Dropping the handle stops the background tasks.
pub struct EventsHandle {
    tasks: Vec<JoinHandle<()>>,
    state: watch::Receiver<ConnectionState>,
}

impl EventsHandle {
    pub fn connection(&self) -> watch::Receiver<ConnectionState> {
        self.state.clone()
    }

    pub fn stop(self) {}
}

impl Drop for EventsHandle {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

type SharedHandler =
    Arc<dyn Fn(InboxEvent) -> BoxFuture<'static, std::result::Result<(), BoxError>> + Send + Sync>;

#[derive(Deserialize)]
struct WsEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    payload: serde_json::Value,
}

fn backoff(o: &EventsOptions, attempt: u32) -> Duration {
    let exp = o
        .backoff_base
        .saturating_mul(1u32.checked_shl(attempt.min(20)).unwrap_or(u32::MAX))
        .min(o.backoff_max);
    exp.mul_f64(0.5 + rand::thread_rng().gen::<f64>() / 2.0)
}

enum Outcome {
    Revoked,
    Expired,
    Dropped,
}

impl NexusClient {
    /// Connects `wss://…/ws/v1/user` with the bearer header and delivers inbox events to `handler`
    /// (drained after every connect and on `events.available`; acked after the handler succeeds).
    pub fn events<F, Fut, E>(&self, handler: F) -> EventsHandle
    where
        F: Fn(InboxEvent) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = std::result::Result<(), E>> + Send + 'static,
        E: Into<BoxError>,
    {
        self.events_with(handler, EventsOptions::default())
    }

    pub fn events_with<F, Fut, E>(&self, handler: F, opts: EventsOptions) -> EventsHandle
    where
        F: Fn(InboxEvent) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = std::result::Result<(), E>> + Send + 'static,
        E: Into<BoxError>,
    {
        let handler: SharedHandler = Arc::new(move |ev| {
            let fut = handler(ev);
            Box::pin(async move { fut.await.map_err(Into::into) })
        });
        let notify = Arc::new(Notify::new());
        let (tx, rx) = watch::channel(ConnectionState::Connecting);
        let drainer = tokio::spawn(drain_loop(
            self.clone(),
            handler,
            notify.clone(),
            opts.clone(),
        ));
        let conn = tokio::spawn(connection_loop(self.clone(), notify, tx, opts));
        EventsHandle {
            tasks: vec![drainer, conn],
            state: rx,
        }
    }
}

async fn drain_loop(
    client: NexusClient,
    handler: SharedHandler,
    notify: Arc<Notify>,
    o: EventsOptions,
) {
    let mut attempt = 0u32;
    loop {
        notify.notified().await;
        loop {
            let h = handler.clone();
            match client
                .drain_inbox_with_limit(move |ev| h(ev), o.inbox_limit)
                .await
            {
                Ok(_) => {
                    attempt = 0;
                    break;
                }
                Err(Error::SignedOut | Error::NotSignedIn) => return,
                Err(_) => {
                    // Handler or transport failure: retry later; nothing was acked past the failure.
                    tokio::time::sleep(backoff(&o, attempt)).await;
                    attempt = attempt.saturating_add(1);
                }
            }
        }
    }
}

async fn connection_loop(
    client: NexusClient,
    notify: Arc<Notify>,
    state: watch::Sender<ConnectionState>,
    o: EventsOptions,
) {
    let mut attempt = 0u32;
    'outer: loop {
        let _ = state.send(ConnectionState::Connecting);
        let token = match client.access_token().await {
            Ok(t) => t,
            Err(Error::SignedOut | Error::NotSignedIn) => break,
            Err(_) => {
                tokio::time::sleep(backoff(&o, attempt)).await;
                attempt = attempt.saturating_add(1);
                continue;
            }
        };
        match run_socket(&client, &token, &notify, &state, &o, &mut attempt).await {
            Ok(Outcome::Revoked) => {
                let _ = client.end_session_locally();
                break;
            }
            Ok(Outcome::Expired) => {
                let _ = state.send(ConnectionState::Disconnected);
                match client.refresh_after_unauthorized(&token).await {
                    Ok(_) => continue 'outer, // reconnect right away with the new token
                    Err(Error::SignedOut | Error::NotSignedIn) => break,
                    Err(_) => {}
                }
            }
            Ok(Outcome::Dropped) => {}
            Err(Error::Api { status: 401, .. }) => {
                if let Err(Error::SignedOut | Error::NotSignedIn) =
                    client.refresh_after_unauthorized(&token).await
                {
                    break;
                }
            }
            Err(_) => {}
        }
        let _ = state.send(ConnectionState::Disconnected);
        tokio::time::sleep(backoff(&o, attempt)).await;
        attempt = attempt.saturating_add(1);
    }
    let _ = state.send(ConnectionState::Stopped);
}

async fn run_socket(
    client: &NexusClient,
    token: &str,
    notify: &Notify,
    state: &watch::Sender<ConnectionState>,
    o: &EventsOptions,
    attempt: &mut u32,
) -> Result<Outcome> {
    let mut req = client
        .config()
        .ws_url()?
        .into_client_request()
        .map_err(|e| Error::WebSocket(e.to_string()))?;
    req.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|e| Error::WebSocket(e.to_string()))?,
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| match e {
            tokio_tungstenite::tungstenite::Error::Http(r) => Error::Api {
                status: r.status().as_u16(),
                code: String::new(),
                description: None,
            },
            e => Error::WebSocket(e.to_string()),
        })?;
    notify.notify_one(); // drain after connect
    let mut ping = tokio::time::interval(o.ping_interval);
    ping.tick().await;
    let mut last_rx = tokio::time::Instant::now();
    loop {
        tokio::select! {
            msg = ws.next() => {
                last_rx = tokio::time::Instant::now();
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(ev) = serde_json::from_str::<WsEvent>(&text) else { continue };
                        match ev.kind.as_str() {
                            "connection.ready" => {
                                *attempt = 0;
                                let session_id = ev.payload.get("sessionId").and_then(|v| v.as_str()).map(str::to_string);
                                let _ = state.send(ConnectionState::Connected { session_id });
                            }
                            "events.available" => notify.notify_one(),
                            "session.revoked" => return Ok(Outcome::Revoked),
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        return Ok(match frame.map(|f| u16::from(f.code)) {
                            Some(CLOSE_REVOKED) => Outcome::Revoked,
                            Some(CLOSE_EXPIRED) => Outcome::Expired,
                            _ => Outcome::Dropped,
                        });
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => return Ok(Outcome::Dropped),
                }
            }
            _ = ping.tick() => {
                if last_rx.elapsed() > o.ping_interval.mul_f64(2.5) {
                    return Ok(Outcome::Dropped);
                }
                if ws.send(Message::Ping(Vec::new())).await.is_err() {
                    return Ok(Outcome::Dropped);
                }
            }
        }
    }
}
