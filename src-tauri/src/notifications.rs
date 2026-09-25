use std::fs;
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::Result;
use crate::events::{AppEvent, NotificationAction, NotificationStatus};

const DATABASE_FILE: &str = "notifications.sqlite3";
const HISTORY_LIMIT: i64 = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub notification_id: String,
    pub job_id: String,
    pub hue_source: String,
    pub title: String,
    pub detail: Option<String>,
    pub icon: Option<String>,
    pub status: NotificationStatus,
    pub progress: Option<u8>,
    pub auto_dismiss_ms: Option<u64>,
    pub actions: Vec<NotificationAction>,
    pub read: bool,
    pub created_at: u64,
}

fn connection(app: &AppHandle) -> Result<Connection> {
    let directory = app.path().app_data_dir()?;
    fs::create_dir_all(&directory)?;
    let connection = Connection::open(directory.join(DATABASE_FILE))?;
    // ponytail: short-lived connections keep this simple; add a shared writer if notification throughput grows.
    connection.busy_timeout(Duration::from_secs(2))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS notifications (
            notification_id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            hue_source TEXT NOT NULL,
            title TEXT NOT NULL,
            detail TEXT,
            icon TEXT,
            status TEXT NOT NULL,
            progress INTEGER,
            auto_dismiss_ms INTEGER,
            actions TEXT NOT NULL,
            read INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );",
    )?;
    Ok(connection)
}

pub fn persist(app: &AppHandle, event: &AppEvent) -> Result<()> {
    match event {
        AppEvent::Notification {
            notification_id,
            job_id,
            hue_source,
            title,
            detail,
            icon,
            status,
            progress,
            auto_dismiss_ms,
            actions,
        } => upsert(
            app,
            &NotificationRecord {
                notification_id: notification_id.clone(),
                job_id: job_id.to_string(),
                hue_source: hue_source.clone(),
                title: title.clone(),
                detail: detail.clone(),
                icon: icon.clone(),
                status: *status,
                progress: *progress,
                auto_dismiss_ms: *auto_dismiss_ms,
                actions: actions.clone(),
                read: false,
                created_at: now_millis(),
            },
        ),
        AppEvent::NotificationDone { job_id, ok } => mark_done(app, &job_id.to_string(), *ok),
        _ => Ok(()),
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn list(app: &AppHandle) -> Result<Vec<NotificationRecord>> {
    let connection = connection(app)?;
    let mut statement = connection.prepare(
        "SELECT notification_id, job_id, hue_source, title, detail, icon, status,
                progress, auto_dismiss_ms, actions, read, created_at
         FROM notifications ORDER BY created_at DESC LIMIT ?1",
    )?;
    let mut rows = statement.query([HISTORY_LIMIT])?;
    let mut records = Vec::new();

    while let Some(row) = rows.next()? {
        let actions_json: String = row.get(9)?;
        let actions = serde_json::from_str(&actions_json)
            .map_err(|error| crate::error::Error::NotificationCorrupt(error.to_string()))?;
        let status_json: String = row.get(6)?;
        let status = serde_json::from_str(&status_json)
            .map_err(|error| crate::error::Error::NotificationCorrupt(error.to_string()))?;
        records.push(NotificationRecord {
            notification_id: row.get(0)?,
            job_id: row.get(1)?,
            hue_source: row.get(2)?,
            title: row.get(3)?,
            detail: row.get(4)?,
            icon: row.get(5)?,
            status,
            progress: row.get(7)?,
            auto_dismiss_ms: row.get(8)?,
            actions,
            read: row.get::<_, i64>(10)? != 0,
            created_at: row.get::<_, i64>(11)? as u64,
        });
    }

    Ok(records)
}

pub fn upsert(app: &AppHandle, record: &NotificationRecord) -> Result<()> {
    let mut connection = connection(app)?;
    let transaction = connection.transaction()?;
    upsert_in(&transaction, record)?;
    transaction.commit()?;
    Ok(())
}

pub fn persist_webhook(
    app: &AppHandle,
    event_id: &str,
    record: &NotificationRecord,
) -> Result<bool> {
    let mut connection = connection(app)?;
    ensure_webhook_table(&connection)?;
    let transaction = connection.transaction()?;
    let inserted = transaction.execute(
        "INSERT OR IGNORE INTO processed_webhook_events (event_id, processed_at) VALUES (?1, ?2)",
        params![event_id, now_millis() as i64],
    )?;
    prune_webhook_events(&transaction)?;
    if inserted == 0 {
        transaction.rollback()?;
        return Ok(false);
    }
    upsert_in(&transaction, record)?;
    transaction.commit()?;
    Ok(true)
}

pub fn webhook_processed(app: &AppHandle, event_id: &str) -> Result<bool> {
    let connection = connection(app)?;
    ensure_webhook_table(&connection)?;
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM processed_webhook_events WHERE event_id = ?1)",
        [event_id],
        |row| row.get(0),
    )?)
}

pub fn ignore_webhook(app: &AppHandle, event_id: &str) -> Result<()> {
    let mut connection = connection(app)?;
    ensure_webhook_table(&connection)?;
    let transaction = connection.transaction()?;
    transaction.execute(
        "INSERT OR IGNORE INTO processed_webhook_events (event_id, processed_at) VALUES (?1, ?2)",
        params![event_id, now_millis() as i64],
    )?;
    prune_webhook_events(&transaction)?;
    transaction.commit()?;
    Ok(())
}

fn ensure_webhook_table(connection: &rusqlite::Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS processed_webhook_events (
            event_id TEXT PRIMARY KEY,
            processed_at INTEGER NOT NULL
        );",
    )?;
    Ok(())
}

fn prune_webhook_events(connection: &rusqlite::Connection) -> Result<()> {
    connection.execute(
        "DELETE FROM processed_webhook_events WHERE processed_at < ?1",
        [now_millis().saturating_sub(30 * 24 * 60 * 60 * 1000) as i64],
    )?;
    Ok(())
}

fn upsert_in(connection: &rusqlite::Connection, record: &NotificationRecord) -> Result<()> {
    let actions = serde_json::to_string(&record.actions)
        .map_err(|error| crate::error::Error::NotificationCorrupt(error.to_string()))?;
    let status = serde_json::to_string(&record.status)
        .map_err(|error| crate::error::Error::NotificationCorrupt(error.to_string()))?;

    connection.execute(
        "INSERT INTO notifications (
            notification_id, job_id, hue_source, title, detail, icon, status,
            progress, auto_dismiss_ms, actions, read, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(notification_id) DO UPDATE SET
            job_id = excluded.job_id,
            hue_source = excluded.hue_source,
            title = excluded.title,
            detail = excluded.detail,
            icon = excluded.icon,
            status = excluded.status,
            progress = excluded.progress,
            auto_dismiss_ms = excluded.auto_dismiss_ms,
            actions = excluded.actions,
            created_at = excluded.created_at",
        params![
            record.notification_id,
            record.job_id,
            record.hue_source,
            record.title,
            record.detail,
            record.icon,
            status,
            record.progress.map(i64::from),
            record.auto_dismiss_ms.map(|value| value as i64),
            actions,
            i64::from(record.read),
            record.created_at as i64,
        ],
    )?;
    connection.execute(
        "DELETE FROM notifications WHERE notification_id NOT IN (
            SELECT notification_id FROM notifications ORDER BY created_at DESC LIMIT ?1
        )",
        [HISTORY_LIMIT],
    )?;
    Ok(())
}

pub fn mark_read(app: &AppHandle, notification_ids: &[String]) -> Result<()> {
    let mut connection = connection(app)?;
    let transaction = connection.transaction()?;
    for notification_id in notification_ids {
        transaction.execute(
            "UPDATE notifications SET read = 1 WHERE notification_id = ?1",
            [notification_id],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn mark_done(app: &AppHandle, job_id: &str, ok: bool) -> Result<()> {
    let connection = connection(app)?;
    let status_value = if ok {
        NotificationStatus::Done
    } else {
        NotificationStatus::Blocked
    };
    let status = serde_json::to_string(&status_value)
        .map_err(|error| crate::error::Error::NotificationCorrupt(error.to_string()))?;
    if ok {
        connection.execute(
            "UPDATE notifications SET status = ?1, progress = 100 WHERE job_id = ?2",
            params![status, job_id],
        )?;
    } else {
        connection.execute(
            "UPDATE notifications SET status = ?1 WHERE job_id = ?2",
            params![status, job_id],
        )?;
    }
    Ok(())
}

pub fn clear(app: &AppHandle) -> Result<()> {
    connection(app)?.execute("DELETE FROM notifications", [])?;
    Ok(())
}
