//! Background work: async, cancellable, and reported through `events`.
//!
//! A job is any core-side work that outlives a single IPC round trip — an
//! agent run, a directory scan, eventually a build watcher. It runs on
//! Tokio's thread pool via `tauri::async_runtime::spawn`, never blocks the
//! command that started it, and reports progress as `AppEvent::Notification`s
//! rather than a single response at the end.
//!
//! `tauri::async_runtime::spawn`, not plain `tokio::spawn`, is required here:
//! a synchronous `#[tauri::command]` (every command in `commands.rs` is one)
//! runs directly on the native IPC callback thread, which has no Tokio
//! runtime entered, so `tokio::spawn`'s `Handle::current()` panics — and
//! since that panic crosses a WebView2 FFI boundary, it aborts the whole
//! process rather than unwinding. `async_runtime::spawn` owns a lazily
//! initialized runtime handle and enters it before spawning, so it works
//! regardless of which thread calls it.
//!
//! The registry and `spawn` below take an `EventSink` rather than an
//! `AppHandle` directly, so job logic can be exercised with a fake sink in
//! tests, with no running Tauri app required. See the tests at the bottom —
//! they run real concurrent work on a real multi-thread runtime.
//!
//! `spawn` and `JobContext` have no caller right now — `jobs::scan`, the one
//! real job that used them, was removed once it had proven the pipeline out
//! (see docs/ARCHITECTURE.md's "Not built yet"). `JobRegistry` stays fully
//! live: `cancel_job` and `is_job_running` are real commands today.
#![allow(
    dead_code,
    reason = "no job producer currently calls spawn — see docs/ARCHITECTURE.md"
)]

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

    tauri::async_runtime::spawn(async move {
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
    use std::time::Duration;

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
        // Proves concurrency with a rendezvous rather than wall-clock timing.
        // `spawn` hands off to `tauri::async_runtime`'s shared global runtime,
        // which every other test in this module also dispatches onto — a
        // fixed wall-clock budget (e.g. "both done in under 55ms") flakes
        // under that cross-test contention regardless of how generous the
        // margin is, since it depends on how much *other* work the shared
        // runtime happens to be doing at the same moment.
        //
        // A two-party barrier sidesteps that: each job only completes once
        // both have reached it, which is only possible if they were actually
        // running at the same time, however long that takes. If `spawn` ever
        // regresses to running jobs one after another, the first job blocks
        // on the barrier forever since the second never starts — caught by
        // the timeout below instead of hanging the test suite.
        let sink = FakeSink::default();
        let registry = JobRegistry::default();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));

        let barrier_a = barrier.clone();
        let a = spawn(
            sink.clone(),
            registry.clone(),
            "a",
            move |_ctx| async move {
                barrier_a.wait().await;
                Ok(())
            },
        );
        let barrier_b = barrier.clone();
        let b = spawn(
            sink.clone(),
            registry.clone(),
            "b",
            move |_ctx| async move {
                barrier_b.wait().await;
                Ok(())
            },
        );

        tokio::time::timeout(Duration::from_secs(5), async {
            wait_until_finished(&registry, &a).await;
            wait_until_finished(&registry, &b).await;
        })
        .await
        .expect("both jobs should reach the barrier concurrently and finish");
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
