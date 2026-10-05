use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::client::{ensure_ok, json_ok, null_as_empty, NexusClient};
use crate::error::{BoxError, Error, Result};

const DEFAULT_LIMIT: u32 = 50;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEvent {
    pub id: String,
    pub seq: i64,
    #[serde(default)]
    pub endpoint_id: String,
    #[serde(default)]
    pub delivery_id: String,
    #[serde(default)]
    pub event_type: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub received_at: String,
}

#[derive(Deserialize)]
struct Page {
    #[serde(default = "Vec::new", deserialize_with = "null_as_empty")]
    events: Vec<InboxEvent>,
}

impl NexusClient {
    /// Delivers pending events of this session in order. After each page, acks up to the last event
    /// whose handler succeeded; a failing handler stops the drain (that event is redelivered next
    /// time) and its error is returned as [`Error::Handler`]. Returns the number handled.
    pub async fn drain_inbox<F, Fut>(&self, handler: F) -> Result<usize>
    where
        F: Fn(InboxEvent) -> Fut,
        Fut: std::future::Future<Output = std::result::Result<(), BoxError>>,
    {
        self.drain_inbox_with_limit(handler, DEFAULT_LIMIT).await
    }

    pub async fn drain_inbox_with_limit<F, Fut>(&self, handler: F, limit: u32) -> Result<usize>
    where
        F: Fn(InboxEvent) -> Fut,
        Fut: std::future::Future<Output = std::result::Result<(), BoxError>>,
    {
        let mut after: Option<i64> = None;
        let mut handled = 0;
        loop {
            let page = self.inbox_page(after, limit).await?;
            let n = page.len();
            let mut last_ok = None;
            let mut failure = None;
            for ev in page {
                let seq = ev.seq;
                match handler(ev).await {
                    Ok(()) => {
                        last_ok = Some(seq);
                        handled += 1;
                    }
                    Err(e) => {
                        failure = Some(Error::Handler(e.to_string()));
                        break;
                    }
                }
            }
            if let Some(seq) = last_ok {
                self.inbox_ack(seq).await?;
            }
            if let Some(e) = failure {
                return Err(e);
            }
            match last_ok {
                Some(seq) if n >= limit as usize => after = Some(seq),
                _ => return Ok(handled),
            }
        }
    }

    async fn inbox_page(&self, after: Option<i64>, limit: u32) -> Result<Vec<InboxEvent>> {
        let r = self
            .authed(Method::GET, "/events/inbox", |r| {
                let r = r.query(&[("limit", limit.to_string())]);
                match after {
                    Some(a) => r.query(&[("after", a.to_string())]),
                    None => r,
                }
            })
            .await?;
        Ok(json_ok::<Page>(r).await?.events)
    }

    async fn inbox_ack(&self, up_to: i64) -> Result<()> {
        let body = json!({ "upTo": up_to });
        let r = self
            .authed(Method::POST, "/events/inbox/ack", |r| r.json(&body))
            .await?;
        ensure_ok(r).await.map(|_| ())
    }
}
