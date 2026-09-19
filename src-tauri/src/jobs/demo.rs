//! A fake job that exists only to prove the async/notification pipeline end
//! to end, since nothing else in Relay produces background work yet.
//!
//! Delete this file, its `pub mod demo;` line in `jobs/mod.rs`, the
//! `CoreCommand::RunDemoJob` variant in `commands.rs`, and its
//! `core_commands()` entry once a real background job — an agent run, a
//! project scan — exists to exercise the pipeline instead.

use std::time::Duration;

use tauri::AppHandle;

use super::{spawn, JobRegistry};
use crate::events::NotificationStatus;

const STEPS: [(&str, u8); 3] = [
    ("Warming up", 10),
    ("Doing the thing", 45),
    ("Almost there", 80),
];

pub fn start(app: AppHandle, registry: JobRegistry) {
    spawn(app, registry, "relay-demo", |ctx| async move {
        for (label, pct) in STEPS {
            ctx.checkpoint()?;
            ctx.report(NotificationStatus::Running, label, None, Some(pct));
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
        ctx.checkpoint()?;
        ctx.report(NotificationStatus::Done, "Wrapping up", None, Some(100));
        tokio::time::sleep(Duration::from_millis(600)).await;
        Ok(())
    });
}
