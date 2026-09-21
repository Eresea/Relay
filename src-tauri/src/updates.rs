//! Signed application updates: one core-owned state machine behind a small IPC surface.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

use crate::error::{Error, Result};
use crate::events::{AppEvent, UpdateSnapshot, UpdateState, CHANNEL};

const DEFAULT_ENDPOINT: &str =
    "https://github.com/Eresea/Relay/releases/latest/download/latest.json";
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

struct PendingUpdate {
    update: Update,
    bytes: Option<Vec<u8>>,
}

struct Inner {
    snapshot: Mutex<UpdateSnapshot>,
    pending: Mutex<Option<PendingUpdate>>,
    operation: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct UpdateManager(Arc<Inner>);

impl Default for UpdateManager {
    fn default() -> Self {
        Self(Arc::new(Inner {
            snapshot: Mutex::new(UpdateSnapshot::default()),
            pending: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
        }))
    }
}

impl UpdateManager {
    pub fn snapshot(&self) -> UpdateSnapshot {
        self.0
            .snapshot
            .lock()
            .expect("update snapshot mutex poisoned")
            .clone()
    }

    pub fn start(&self, app: AppHandle) {
        if public_key().is_none() {
            return;
        }

        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            loop {
                if let Err(error) = manager.check_and_download(app.clone()).await {
                    log::warn!("update check failed: {error}");
                }
                tokio::time::sleep(CHECK_INTERVAL).await;
            }
        });
    }

    pub async fn check_and_download(&self, app: AppHandle) -> Result<()> {
        let _operation = self.0.operation.lock().await;
        self.set_state(
            &app,
            update_snapshot(UpdateState::Checking, None, None, 0, None, None),
        );

        let update = match fetch_update(&app).await {
            Ok(update) => update,
            Err(error) => {
                self.set_state(
                    &app,
                    update_snapshot(
                        UpdateState::Error,
                        None,
                        None,
                        0,
                        None,
                        Some(error.to_string()),
                    ),
                );
                return Err(error);
            }
        };

        let Some(update) = update else {
            self.0
                .pending
                .lock()
                .expect("pending update mutex poisoned")
                .take();
            self.set_state(
                &app,
                update_snapshot(UpdateState::Idle, None, None, 0, None, None),
            );
            return Ok(());
        };

        let version = update.version.clone();
        let notes = update.body.clone();
        let already_ready = self
            .0
            .pending
            .lock()
            .expect("pending update mutex poisoned")
            .as_ref()
            .is_some_and(|pending| pending.update.version == version && pending.bytes.is_some());

        if already_ready {
            self.set_state(
                &app,
                update_snapshot(
                    UpdateState::Ready,
                    Some(version),
                    notes,
                    self.snapshot().downloaded_bytes,
                    self.snapshot().content_length,
                    None,
                ),
            );
            return Ok(());
        }

        *self
            .0
            .pending
            .lock()
            .expect("pending update mutex poisoned") = Some(PendingUpdate {
            update,
            bytes: None,
        });
        self.set_state(
            &app,
            update_snapshot(UpdateState::Available, Some(version), notes, 0, None, None),
        );
        self.download_pending(&app).await
    }

    pub async fn download(&self, app: AppHandle) -> Result<()> {
        let _operation = self.0.operation.lock().await;
        self.download_pending(&app).await
    }

    pub async fn install(&self, app: AppHandle) -> Result<()> {
        let _operation = self.0.operation.lock().await;
        let Some(mut pending) = self
            .0
            .pending
            .lock()
            .expect("pending update mutex poisoned")
            .take()
        else {
            return Err(Error::NoUpdateAvailable);
        };

        let Some(bytes) = pending.bytes.take() else {
            let version = pending.update.version.clone();
            *self
                .0
                .pending
                .lock()
                .expect("pending update mutex poisoned") = Some(pending);
            self.set_state(
                &app,
                update_snapshot(
                    UpdateState::Error,
                    Some(version),
                    None,
                    0,
                    None,
                    Some(Error::UpdateNotDownloaded.to_string()),
                ),
            );
            return Err(Error::UpdateNotDownloaded);
        };

        let version = pending.update.version.clone();
        self.set_state(
            &app,
            update_snapshot(
                UpdateState::Installing,
                Some(version),
                None,
                self.snapshot().downloaded_bytes,
                self.snapshot().content_length,
                None,
            ),
        );

        if let Err(error) = pending.update.install(bytes) {
            self.set_state(
                &app,
                update_snapshot(
                    UpdateState::Error,
                    Some(pending.update.version),
                    None,
                    0,
                    None,
                    Some(error.to_string()),
                ),
            );
            return Err(error.into());
        }

        app.restart();
    }

    async fn download_pending(&self, app: &AppHandle) -> Result<()> {
        let Some(mut pending) = self
            .0
            .pending
            .lock()
            .expect("pending update mutex poisoned")
            .take()
        else {
            return Err(Error::NoUpdateAvailable);
        };

        if let Some(bytes) = pending.bytes.take() {
            let version = pending.update.version.clone();
            let downloaded_bytes = bytes.len() as u64;
            pending.bytes = Some(bytes);
            *self
                .0
                .pending
                .lock()
                .expect("pending update mutex poisoned") = Some(pending);
            self.set_state(
                app,
                update_snapshot(
                    UpdateState::Ready,
                    Some(version),
                    None,
                    downloaded_bytes,
                    Some(downloaded_bytes),
                    None,
                ),
            );
            return Ok(());
        }

        let version = pending.update.version.clone();
        let notes = pending.update.body.clone();
        self.set_state(
            app,
            update_snapshot(
                UpdateState::Downloading,
                Some(version.clone()),
                notes.clone(),
                0,
                None,
                None,
            ),
        );

        let mut downloaded = 0_u64;
        let manager = self.clone();
        let progress_app = app.clone();
        let result = pending
            .update
            .download(
                |chunk, content_length| {
                    downloaded += chunk as u64;
                    manager.set_state(
                        &progress_app,
                        update_snapshot(
                            UpdateState::Downloading,
                            Some(version.clone()),
                            notes.clone(),
                            downloaded,
                            content_length,
                            None,
                        ),
                    );
                },
                || {},
            )
            .await;

        match result {
            Ok(bytes) => {
                let content_length = Some(bytes.len() as u64);
                let downloaded_bytes = bytes.len() as u64;
                pending.bytes = Some(bytes);
                *self
                    .0
                    .pending
                    .lock()
                    .expect("pending update mutex poisoned") = Some(pending);
                self.set_state(
                    app,
                    update_snapshot(
                        UpdateState::Ready,
                        Some(version),
                        notes,
                        downloaded_bytes,
                        content_length,
                        None,
                    ),
                );
                Ok(())
            }
            Err(error) => {
                *self
                    .0
                    .pending
                    .lock()
                    .expect("pending update mutex poisoned") = Some(pending);
                self.set_state(
                    app,
                    update_snapshot(
                        UpdateState::Error,
                        Some(version),
                        notes,
                        downloaded,
                        None,
                        Some(error.to_string()),
                    ),
                );
                Err(error.into())
            }
        }
    }

    fn set_state(&self, app: &AppHandle, snapshot: UpdateSnapshot) {
        *self
            .0
            .snapshot
            .lock()
            .expect("update snapshot mutex poisoned") = snapshot.clone();
        if let Err(error) = app.emit(CHANNEL, AppEvent::UpdateChanged { snapshot }) {
            log::debug!("could not emit update state: {error}");
        }
    }
}

fn update_snapshot(
    state: UpdateState,
    version: Option<String>,
    notes: Option<String>,
    downloaded_bytes: u64,
    content_length: Option<u64>,
    error: Option<String>,
) -> UpdateSnapshot {
    UpdateSnapshot {
        state,
        current_version: env!("CARGO_PKG_VERSION").to_owned(),
        version,
        notes,
        downloaded_bytes,
        content_length,
        error,
    }
}

fn public_key() -> Option<&'static str> {
    option_env!("RELAY_UPDATER_PUBLIC_KEY").filter(|key| !key.trim().is_empty())
}

async fn fetch_update(app: &AppHandle) -> Result<Option<Update>> {
    let Some(public_key) = public_key() else {
        return Ok(None);
    };
    let endpoint = option_env!("RELAY_UPDATE_ENDPOINT")
        .filter(|endpoint| !endpoint.trim().is_empty())
        .unwrap_or(DEFAULT_ENDPOINT);
    let endpoint = Url::parse(endpoint)
        .map_err(|error| Error::UpdaterConfiguration(format!("{endpoint}: {error}")))?;
    let updater = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])?
        .build()?;
    Ok(updater.check().await?)
}
