//! Pinned web apps: any URL as a module of its own, with a Deck tab.
//!
//! Each app runs in a borderless window of its own, owned by the main window
//! and laid exactly over the rectangle its tab leaves for it; when the main
//! window moves, resizes or hides, the app follows. Not a child webview of
//! the main window: that needs Tauri's `unstable` feature, which turns every
//! window's webview into a child webview and leaves the transparent overlay
//! windows blank on Windows. Every app gets its own data directory, so its
//! cookies and logins are its own, apart from Relay and from every other app.
//! A window exists only while its tab is open: closing the tab destroys it,
//! so an app you are not using costs no memory.
//!
//! A pinned page is someone else's code. It holds no Tauri capability (none
//! lists a remote URL), and the IPC gate in `lib.rs` refuses every call from
//! a `webapp-` webview besides, so a page can never drive the core.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow};
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};
use crate::events::{AppEvent, EventSink};

const SETTINGS_KEY: &str = "webapps";
/// Webviews of pinned apps carry this label prefix; the IPC gate keys on it.
pub const LABEL_PREFIX: &str = "webapp-";
/// Module ids of pinned apps, apart from built-in ones.
pub const MODULE_PREFIX: &str = "web-";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebApp {
    pub id: String,
    pub name: String,
    pub url: String,
}

impl WebApp {
    pub fn module_id(&self) -> String {
        format!("{MODULE_PREFIX}{}", self.id)
    }

    pub fn host(&self) -> String {
        url::Url::parse(&self.url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .unwrap_or_else(|| self.url.clone())
    }
}

fn web_error(message: impl std::fmt::Display) -> Error {
    std::io::Error::other(message.to_string()).into()
}

/// Accepts http(s) URLs, adding https:// when only a host is given.
fn normalize_url(raw: &str) -> Result<url::Url> {
    let raw = raw.trim();
    let with_scheme = if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("https://{raw}")
    };
    let url = url::Url::parse(&with_scheme)
        .map_err(|_| web_error(format!("{raw} is not a web address")))?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err(web_error("Only http and https addresses can be pinned"));
    }
    Ok(url)
}

/// A short, stable id from the name, unique among `taken`.
fn new_id(name: &str, taken: &[WebApp]) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let base = if slug.is_empty() {
        "app".to_owned()
    } else {
        slug.chars().take(24).collect()
    };
    let mut id = base.clone();
    let mut n = 2;
    while taken.iter().any(|app| app.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

pub fn list(app: &AppHandle) -> Vec<WebApp> {
    app.store("settings.json")
        .ok()
        .and_then(|store| store.get(SETTINGS_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, apps: &[WebApp]) -> Result<()> {
    app.store("settings.json")
        .map_err(|error| Error::Settings(error.to_string()))?
        .set(SETTINGS_KEY, serde_json::json!(apps));
    Ok(())
}

fn get(app: &AppHandle, id: &str) -> Result<WebApp> {
    list(app)
        .into_iter()
        .find(|candidate| candidate.id == id)
        .ok_or_else(|| web_error("That web app is no longer pinned"))
}

fn data_dir(app: &AppHandle, id: &str) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("webapps").join(id))
}

fn label(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

pub fn pin(app: &AppHandle, name: &str, url: &str) -> Result<WebApp> {
    let url = normalize_url(url)?;
    let mut apps = list(app);
    let name = match name.trim() {
        "" => url.host_str().unwrap_or("Web app").to_owned(),
        name => name.to_owned(),
    };
    let pinned = WebApp {
        id: new_id(&name, &apps),
        name,
        url: url.to_string(),
    };
    apps.push(pinned.clone());
    save(app, &apps)?;
    app.emit(AppEvent::ModulesChanged);
    Ok(pinned)
}

/// Unpins an app and forgets its session: its data directory goes too.
pub fn unpin(app: &AppHandle, id: &str) -> Result<()> {
    close(app, id)?;
    let apps: Vec<WebApp> = list(app)
        .into_iter()
        .filter(|candidate| candidate.id != id)
        .collect();
    save(app, &apps)?;
    let dir = data_dir(app, id)?;
    // WebView2 may hold the folder for a moment after the webview closes;
    // an orphaned folder is harmless and goes with the next unpin.
    let _ = std::fs::remove_dir_all(dir);
    app.emit(AppEvent::ModulesChanged);
    Ok(())
}

/// Where each showing app sits, in CSS pixels of the main window's content.
/// The main window can move without the page noticing, so the core keeps the
/// last rectangle and re-places the app from it (`follow_main`).
static PLACED: Mutex<Option<HashMap<String, Rect>>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn placed<T>(work: impl FnOnce(&mut HashMap<String, Rect>) -> T) -> T {
    let mut guard = PLACED.lock().unwrap_or_else(PoisonError::into_inner);
    work(guard.get_or_insert_with(HashMap::new))
}

/// `rect`, in CSS pixels of the main window's content, on the screen.
fn screen_bounds(
    main: &WebviewWindow,
    rect: Rect,
) -> Result<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    let origin = main.inner_position()?;
    let scale = main.scale_factor()?;
    let position = PhysicalPosition::new(
        origin.x + (rect.x * scale).round() as i32,
        origin.y + (rect.y * scale).round() as i32,
    );
    let size = PhysicalSize::new(
        (rect.width * scale).round().max(1.0) as u32,
        (rect.height * scale).round().max(1.0) as u32,
    );
    Ok((position, size))
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow> {
    app.get_webview_window(crate::overlay::MAIN)
        .ok_or(Error::MissingWindow(crate::overlay::MAIN))
}

fn place(window: &WebviewWindow, main: &WebviewWindow, rect: Rect) -> Result<()> {
    let (position, size) = screen_bounds(main, rect)?;
    window.set_position(position)?;
    window.set_size(size)?;
    Ok(())
}

/// Lays the app over `x, y, width, height` (CSS pixels of the main window's
/// content), creating its window the first time.
#[cfg(desktop)]
pub fn show(app: &AppHandle, id: &str, x: f64, y: f64, width: f64, height: f64) -> Result<()> {
    let rect = Rect {
        x,
        y,
        width,
        height,
    };
    let main = main_window(app)?;
    if let Some(window) = app.get_webview_window(&label(id)) {
        place(&window, &main, rect)?;
        window.show()?;
        placed(|all| all.insert(id.to_owned(), rect));
        return Ok(());
    }
    let pinned = get(app, id)?;
    if !crate::modules::is_enabled(app, &pinned.module_id()) {
        return Err(Error::ModuleOff("this web app"));
    }
    let url = normalize_url(&pinned.url)?;
    let window = tauri::WebviewWindowBuilder::new(app, label(id), WebviewUrl::External(url))
        .title(&pinned.name)
        .data_directory(data_dir(app, id)?)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        // Owned by the main window: always above it, minimised with it.
        .parent(&main)?
        .build()?;
    place(&window, &main, rect)?;
    window.show()?;
    placed(|all| all.insert(id.to_owned(), rect));
    Ok(())
}

/// Re-places every showing app after the main window moved or resized.
pub fn follow_main(app: &AppHandle) {
    let Ok(main) = main_window(app) else { return };
    let showing: Vec<(String, Rect)> =
        placed(|all| all.iter().map(|(id, rect)| (id.clone(), *rect)).collect());
    for (id, rect) in showing {
        if let Some(window) = app.get_webview_window(&label(&id)) {
            let _ = place(&window, &main, rect);
        }
    }
}

/// Takes every app off screen with the main window; their tabs bring them back.
pub fn hide_all(app: &AppHandle) {
    let showing: Vec<String> = placed(|all| all.drain().map(|(id, _)| id).collect());
    for id in showing {
        if let Some(window) = app.get_webview_window(&label(&id)) {
            let _ = window.hide();
        }
    }
}

/// Takes the app off screen while another tab is showing; it keeps running.
pub fn hide(app: &AppHandle, id: &str) -> Result<()> {
    placed(|all| all.remove(id));
    if let Some(window) = app.get_webview_window(&label(id)) {
        window.hide()?;
    }
    Ok(())
}

/// Destroys the app's window, freeing its memory. Its session stays on disk.
/// `destroy`, not `close`: every close request is turned into a hide.
pub fn close(app: &AppHandle, id: &str) -> Result<()> {
    placed(|all| all.remove(id));
    if let Some(window) = app.get_webview_window(&label(id)) {
        window.destroy()?;
    }
    Ok(())
}

#[tauri::command]
pub fn webapps_list(app: AppHandle) -> Vec<WebApp> {
    list(&app)
}

#[tauri::command]
pub fn webapps_pin(app: AppHandle, name: String, url: String) -> Result<WebApp> {
    pin(&app, &name, &url)
}

#[tauri::command]
pub fn webapps_unpin(app: AppHandle, id: String) -> Result<()> {
    unpin(&app, &id)
}

/// Async on purpose: building a webview inside a synchronous command can
/// deadlock WebView2, which needs the main thread free to pump messages.
#[cfg(desktop)]
#[tauri::command]
pub async fn webapps_show(
    app: AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || show(&app, &id, x, y, width, height))
        .await
        .map_err(|error| std::io::Error::other(error.to_string()))?
}

#[tauri::command]
pub fn webapps_hide(app: AppHandle, id: String) -> Result<()> {
    hide(&app, &id)
}

#[tauri::command]
pub fn webapps_close(app: AppHandle, id: String) -> Result<()> {
    close(&app, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_get_a_scheme_and_only_web_ones_pass() {
        assert_eq!(
            normalize_url("grafana.example.com/d/x").unwrap().as_str(),
            "https://grafana.example.com/d/x"
        );
        assert!(normalize_url("http://localhost:3000").is_ok());
        assert!(normalize_url("file:///C:/Windows").is_err());
        assert!(normalize_url("javascript:alert(1)").is_err());
        assert!(normalize_url("not a url").is_err());
    }

    #[test]
    fn ids_come_from_names_and_stay_unique() {
        let taken = vec![WebApp {
            id: "grafana".into(),
            name: "Grafana".into(),
            url: "https://g".into(),
        }];
        assert_eq!(new_id("Grafana", &taken), "grafana-2");
        assert_eq!(new_id("My Mail!", &[]), "my-mail");
        assert_eq!(new_id("???", &[]), "app");
    }
}
