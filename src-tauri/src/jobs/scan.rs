//! Walks the user's home directory in the background, counting files and
//! folders as it goes.
//!
//! This is the first real producer through the job/event pipeline that
//! `jobs::demo` used to stand in for — see the "Not built yet" note it
//! carried in `docs/ARCHITECTURE.md`. It is deliberately simple (a count, not
//! an index) because the point right now is exercising checkpointing and
//! progress reporting against real, unpredictable I/O rather than a sleep
//! loop, not building the eventual project-scan feature.

use std::collections::VecDeque;

use tauri::{AppHandle, Manager};

use super::{spawn, JobRegistry};
use crate::error::Result;
use crate::events::NotificationStatus;

/// How many entries to process between progress reports. Reporting on every
/// entry would flood the HUD; this keeps updates visible without spamming
/// the event channel while scanning a large home directory.
const REPORT_EVERY: u64 = 200;

pub fn start(app: AppHandle, registry: JobRegistry) -> Result<()> {
    let root = app.path().home_dir()?;

    spawn(app, registry, "relay-scan", move |ctx| async move {
        let mut files = 0u64;
        let mut dirs = 0u64;
        let mut queue = VecDeque::from([root]);

        while let Some(dir) = queue.pop_front() {
            ctx.checkpoint()?;

            let mut entries = match tokio::fs::read_dir(&dir).await {
                Ok(entries) => entries,
                Err(error) => {
                    log::warn!("scan: skipping {}: {error}", dir.display());
                    continue;
                }
            };

            loop {
                let entry = match entries.next_entry().await {
                    Ok(Some(entry)) => entry,
                    Ok(None) => break,
                    Err(error) => {
                        log::warn!(
                            "scan: could not read an entry of {}: {error}",
                            dir.display()
                        );
                        break;
                    }
                };

                // `file_type()` reads the entry's own type without following
                // symlinks, so a symlinked directory counts as a file here
                // rather than being descended into — the simplest way to
                // avoid a cycle through a symlink loop.
                match entry.file_type().await {
                    Ok(file_type) if file_type.is_dir() => {
                        dirs += 1;
                        queue.push_back(entry.path());
                    }
                    Ok(_) => files += 1,
                    Err(error) => {
                        log::warn!("scan: could not stat {}: {error}", entry.path().display());
                        continue;
                    }
                }

                if (files + dirs) % REPORT_EVERY == 0 {
                    ctx.checkpoint()?;
                    ctx.report(
                        NotificationStatus::Running,
                        "Scanning home folder",
                        Some(format!("{files} files, {dirs} folders")),
                        None,
                    );
                }
            }
        }

        ctx.report(
            NotificationStatus::Done,
            "Scan complete",
            Some(format!("{files} files, {dirs} folders")),
            Some(100),
        );
        Ok(())
    });

    Ok(())
}
