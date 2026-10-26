//! Questions a job puts to you: "may Claude run `npm test`?".
//!
//! A job asks with [`Approvals::ask`], shows the request on its notification
//! card with Allow and Deny actions carrying the request id, and awaits the
//! receiver. Whichever window you answer in calls `approval_answer`, which
//! resolves the waiting job.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use crate::error::{Error, Result};

#[derive(Clone, Default)]
pub struct Approvals(Arc<Inner>);

#[derive(Default)]
struct Inner {
    next: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl Approvals {
    /// A new open question: its id for the card, and where the answer lands.
    pub fn ask(&self) -> (String, oneshot::Receiver<bool>) {
        let id = format!(
            "approval-{}",
            self.0.next.fetch_add(1, Ordering::Relaxed) + 1
        );
        let (sender, receiver) = oneshot::channel();
        self.0.pending.lock().unwrap().insert(id.clone(), sender);
        (id, receiver)
    }

    /// Answers once; a second answer, or one for a question that timed out,
    /// is refused rather than silently ignored.
    pub fn answer(&self, id: &str, allow: bool) -> Result<()> {
        let sender = self
            .0
            .pending
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| Error::UnknownApproval(id.to_owned()))?;
        let _ = sender.send(allow);
        Ok(())
    }

    /// Drops a question nobody answered in time.
    pub fn forget(&self, id: &str) {
        self.0.pending.lock().unwrap().remove(id);
    }
}

#[tauri::command]
pub fn approval_answer(
    approvals: tauri::State<Approvals>,
    request: String,
    allow: bool,
) -> Result<()> {
    approvals.answer(&request, allow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_answer_reaches_the_asking_job_once() {
        let approvals = Approvals::default();
        let (id, answer) = approvals.ask();
        approvals.answer(&id, true).unwrap();
        assert!(answer.await.unwrap());
        assert!(approvals.answer(&id, false).is_err());

        let (late, _receiver) = approvals.ask();
        approvals.forget(&late);
        assert!(approvals.answer(&late, true).is_err());
    }
}
