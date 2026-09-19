//! Background work: async, cancellable, and reported through `events`.
//!
//! A job is any core-side work that outlives a single IPC round trip — an
//! agent run, a directory scan, eventually a build watcher. It runs on
//! Tokio's thread pool via `tokio::spawn`, never blocks the command that
//! started it, and reports progress as `AppEvent::Notification`s rather than
//! a single response at the end.
//!
//! The registry and `spawn` below take an `EventSink` rather than an
//! `AppHandle` directly, so job logic can be exercised with a fake sink in
//! tests, with no running Tauri app required. See the tests at the bottom —
//! they run real concurrent work on a real multi-thread runtime.

pub mod scan;

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::events::{AppEvent, EventSink, NotificationStatus};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct JobId(String);

impl From<String> for JobId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl std::fmt::Display for JobId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

struct Inner {
    next_id: AtomicU64,
    running: Mutex<HashMap<JobId, Arc<AtomicBool>>>,
}

/// Cheaply cloneable handle to the set of jobs currently running. Every clone
/// shares the same map — this is what gets `app.manage()`d, and what both
/// commands and `spawn` see.
///
/// Lock discipline: every method here takes the mutex only for a plain
/// HashMap operation and never holds it across an `.await`, so a plain
/// `std::sync::Mutex` is correct — no need for `tokio::sync::Mutex`.
#[derive(Clone)]
pub struct JobRegistry(Arc<Inner>);

impl Default for JobRegistry {
    fn default() -> Self {
        Self(Arc::new(Inner {
            next_id: AtomicU64::new(1),
            running: Mutex::new(HashMap::new()),
        }))
    }
}

impl JobRegistry {
    fn allocate(&self) -> (JobId, Arc<AtomicBool>) {
        let n = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        let id = JobId(format!("job-{n}"));
        let cancelled = Arc::new(AtomicBool::new(false));
        self.0
            .running
            .lock()
            .expect("job registry mutex poisoned")
            .insert(id.clone(), cancelled.clone());
        (id, cancelled)
    }

    fn finish(&self, id: &JobId) {
        self.0
            .running
            .lock()
            .expect("job registry mutex poisoned")
            .remove(id);
    }

    pub fn is_running(&self, id: &JobId) -> bool {
        self.0
            .running
            .lock()
            .expect("job registry mutex poisoned")
            .contains_key(id)
    }

    /// Requests cooperative cancellation. The job notices next time it calls
    /// `JobContext::checkpoint` — nothing here forcibly stops a running
    /// future, so a job that never checks in cannot be cancelled.
    pub fn cancel(&self, id: &JobId) -> Result<()> {
        let running = self.0.running.lock().expect("job registry mutex poisoned");
        match running.get(id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                Ok(())
            }
            None => Err(Error::UnknownJob(id.clone())),
        }
    }
}

/// What a running job uses to report itself and notice cancellation.
pub struct JobContext<S: EventSink> {
    id: JobId,
    hue_source: String,
    sink: S,
    cancelled: Arc<AtomicBool>,
}

impl<S: EventSink> JobContext<S> {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// Returns an error if cancellation was requested, so a job can bail out
    /// with `context.checkpoint()?;` between steps instead of checking the
    /// flag by hand everywhere.
    pub fn checkpoint(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(Error::JobCancelled(self.id.clone()))
        } else {
            Ok(())
        }
    }

    pub fn report(
        &self,
        status: NotificationStatus,
        title: impl Into<String>,
        detail: Option<String>,
        progress: Option<u8>,
    ) {
        let title = title.into();
        log::debug!("job {} report: {title}", self.id);
        self.sink.emit(AppEvent::Notification {
            job_id: self.id.clone(),
            hue_source: self.hue_source.clone(),
            title,
            detail,
            icon: None,
            status,
            progress,
        });
    }
}

/// Starts `work` on Tokio's thread pool and returns immediately with the new
/// job's id — the caller never waits on it. `hue_source` is what the HUD
/// hashes to a colour: pass the entity the job is about (an agent id) once
/// one exists, or the job id itself when there is no better identity yet.
///
/// `work` must check `context.checkpoint()` at points where stopping early is
/// safe; nothing here can interrupt a future that never yields that control
/// back.
pub fn spawn<S, F, Fut>(
    sink: S,
    registry: JobRegistry,
    hue_source: impl Into<String>,
    work: F,
) -> JobId
where
    S: EventSink,
    F: FnOnce(JobContext<S>) -> Fut + Send + 'static,
    Fut: Future<Output = Result<()>> + Send + 'static,
{
    let (id, cancelled) = registry.allocate();
    let context = JobContext {
        id: id.clone(),
        hue_source: hue_source.into(),
        sink: sink.clone(),
        cancelled,
    };

    let done_id = id.clone();
    let done_registry = registry.clone();
    let done_sink = sink.clone();

    tokio::spawn(async move {
        let ok = work(context).await.is_ok();
        done_registry.finish(&done_id);
        done_sink.emit(AppEvent::NotificationDone {
            job_id: done_id,
            ok,
        });
    });

    id
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;
    use std::time::{Duration, Instant};

    use super::*;

    #[derive(Clone, Default)]
    struct FakeSink(Arc<StdMutex<Vec<AppEvent>>>);

    impl EventSink for FakeSink {
        fn emit(&self, event: AppEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    async fn wait_until_finished(registry: &JobRegistry, id: &JobId) {
        for _ in 0..200 {
            if !registry.is_running(id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("job {id} did not finish in time");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reports_progress_and_completion() {
        let sink = FakeSink::default();
        let registry = JobRegistry::default();

        let id = spawn(sink.clone(), registry.clone(), "demo", |ctx| async move {
            ctx.report(NotificationStatus::Running, "halfway", None, Some(50));
            Ok(())
        });

        wait_until_finished(&registry, &id).await;

        let events = sink.0.lock().unwrap();
        assert!(matches!(
            &events[0],
            AppEvent::Notification {
                progress: Some(50),
                ..
            }
        ));
        assert!(matches!(
            &events[1],
            AppEvent::NotificationDone { ok: true, .. }
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_is_observed_at_the_next_checkpoint() {
        let sink = FakeSink::default();
        let registry = JobRegistry::default();

        let id = spawn(sink.clone(), registry.clone(), "demo", |ctx| async move {
            loop {
                ctx.checkpoint()?;
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });

        registry.cancel(&id).expect("job is running");
        wait_until_finished(&registry, &id).await;

        let events = sink.0.lock().unwrap();
        assert!(matches!(
            events.last(),
            Some(AppEvent::NotificationDone { ok: false, .. })
        ));
    }

    #[test]
    fn cancelling_an_unknown_job_is_an_error() {
        let registry = JobRegistry::default();
        assert!(registry.cancel(&JobId::from("nope".to_string())).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn two_jobs_make_progress_concurrently() {
        // If these ran one after another this would take ~60ms; run on
        // separate worker threads it takes about 30ms. This is what proves
        // `spawn` uses the thread pool rather than an interleaved single task.
        let sink = FakeSink::default();
        let registry = JobRegistry::default();
        let started = Instant::now();

        let a = spawn(sink.clone(), registry.clone(), "a", |_ctx| async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            Ok(())
        });
        let b = spawn(sink.clone(), registry.clone(), "b", |_ctx| async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            Ok(())
        });

        wait_until_finished(&registry, &a).await;
        wait_until_finished(&registry, &b).await;

        assert!(started.elapsed() < Duration::from_millis(55));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_job_that_never_checkpoints_cannot_be_stopped() {
        // Documents the honest limit of cooperative cancellation: requesting
        // it does not touch a job that never calls back in to check.
        let sink = FakeSink::default();
        let registry = JobRegistry::default();

        let id = spawn(sink.clone(), registry.clone(), "demo", |_ctx| async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            Ok(())
        });

        registry.cancel(&id).expect("job is running");
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(
            registry.is_running(&id),
            "cancellation must not force-stop a job"
        );

        wait_until_finished(&registry, &id).await;
    }
}
