//! Global shortcuts: one opens the palette, one opens the attention stack.
//!
//! Both are rebindable in Settings and stored in `settings.json` under
//! `shortcuts`. Registration can fail when another application already owns
//! a combination. That is a normal condition on a busy desktop, not a crash,
//! but it must not be silent either: a shortcut that does nothing looks like
//! a broken Relay. So each binding keeps a status (active, taken, invalid)
//! that Settings shows, and a shortcut taken at startup raises a card that
//! leads to Settings. Each shortcut registers on its own, so losing one never
//! costs the other.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{App, AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};
use crate::events::{AppEvent, EventSink, NotificationAction, NotificationStatus};

const SETTINGS_KEY: &str = "shortcuts";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Palette,
    Attention,
}

impl Action {
    const ALL: [Action; 2] = [Action::Palette, Action::Attention];

    fn key(self) -> &'static str {
        match self {
            Self::Palette => "palette",
            Self::Attention => "attention",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Palette => "Open the Omnibar",
            Self::Attention => "Open the attention stack",
        }
    }

    fn default_accelerator(self) -> &'static str {
        match self {
            Self::Palette => "Ctrl+Space",
            // Not Ctrl+. — a global shortcut is taken from every other
            // application, and that one is the quick-fix key in most editors.
            Self::Attention => "Ctrl+Alt+Space",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Active,
    /// Another application owns the combination.
    Taken,
    /// The stored combination is not one Relay can register.
    Invalid,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutInfo {
    pub action: Action,
    pub label: &'static str,
    pub accelerator: String,
    pub default: &'static str,
    pub status: Status,
    pub message: Option<String>,
}

struct Binding {
    accelerator: String,
    /// Registered with the OS; None while taken or invalid.
    shortcut: Option<Shortcut>,
    status: Status,
    message: Option<String>,
}

/// The current binding of each action, in `Action::ALL` order.
#[derive(Default)]
pub struct Shortcuts(Mutex<Vec<(Action, Binding)>>);

fn is_function_key(code: Code) -> bool {
    use Code::*;
    matches!(
        code,
        F1 | F2
            | F3
            | F4
            | F5
            | F6
            | F7
            | F8
            | F9
            | F10
            | F11
            | F12
            | F13
            | F14
            | F15
            | F16
            | F17
            | F18
            | F19
            | F20
            | F21
            | F22
            | F23
            | F24
    )
}

/// Parses a combination like `Ctrl+Alt+Space`. A bare key would be taken
/// from typing in every application, so one needs a modifier unless it is a
/// function key.
fn parse(accelerator: &str) -> std::result::Result<Shortcut, String> {
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| format!("“{accelerator}” is not a combination Relay can use"))?;
    if shortcut.mods.is_empty() && !is_function_key(shortcut.key) {
        return Err(format!(
            "{accelerator} needs Ctrl, Alt, Shift or Win: a single key would be taken from typing everywhere"
        ));
    }
    Ok(shortcut)
}

fn taken_message(accelerator: &str) -> String {
    format!("{accelerator} is taken by another application. Choose another combination.")
}

fn stored(app: &AppHandle) -> HashMap<String, String> {
    app.store("settings.json")
        .ok()
        .and_then(|store| store.get(SETTINGS_KEY))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, bindings: &[(Action, Binding)]) -> Result<()> {
    let map: HashMap<&str, &str> = bindings
        .iter()
        .map(|(action, binding)| (action.key(), binding.accelerator.as_str()))
        .collect();
    app.store("settings.json")
        .map_err(|error| Error::Settings(error.to_string()))?
        .set(SETTINGS_KEY, serde_json::json!(map));
    Ok(())
}

/// Tries to take `accelerator` from the OS and says how that went.
fn bind(app: &AppHandle, accelerator: String) -> Binding {
    match parse(&accelerator) {
        Err(message) => Binding {
            accelerator,
            shortcut: None,
            status: Status::Invalid,
            message: Some(message),
        },
        Ok(shortcut) => match app.global_shortcut().register(shortcut) {
            Ok(()) => Binding {
                accelerator,
                shortcut: Some(shortcut),
                status: Status::Active,
                message: None,
            },
            Err(error) => {
                log::warn!("global shortcut {accelerator} is unavailable: {error}");
                Binding {
                    message: Some(taken_message(&accelerator)),
                    accelerator,
                    shortcut: None,
                    status: Status::Taken,
                }
            }
        },
    }
}

fn info(action: Action, binding: &Binding) -> ShortcutInfo {
    ShortcutInfo {
        action,
        label: action.label(),
        accelerator: binding.accelerator.clone(),
        default: action.default_accelerator(),
        status: binding.status.clone(),
        message: binding.message.clone(),
    }
}

/// A card that says which shortcut does not work and leads to Settings.
fn report_broken(app: &AppHandle, action: Action, binding: &Binding) {
    let id = format!("shortcut-{}", action.key());
    app.emit(AppEvent::Notification {
        notification_id: id.clone(),
        job_id: id.into(),
        hue_source: "relay".to_owned(),
        title: format!("{} has no shortcut", action.label()),
        detail: binding.message.clone(),
        icon: Some("command".to_owned()),
        status: NotificationStatus::Waiting,
        progress: None,
        auto_dismiss_ms: None,
        actions: vec![NotificationAction::Open {
            label: "Change shortcut".to_owned(),
            url: "relay://settings/shortcuts".to_owned(),
        }],
    });
}

pub fn register(app: &App) {
    use tauri_plugin_global_shortcut::Builder;

    app.manage(Shortcuts::default());
    let plugin = Builder::new()
        .with_handler(|app, shortcut, event| {
            // Fire on press only; without this every toggle runs twice per
            // keystroke and appears not to work at all.
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let action = app
                .state::<Shortcuts>()
                .0
                .lock()
                .unwrap()
                .iter()
                .find(|(_, binding)| binding.shortcut.as_ref() == Some(shortcut))
                .map(|(action, _)| *action);
            match action {
                Some(Action::Attention) => toggle_attention(app),
                Some(Action::Palette) => {
                    if let Err(error) = crate::overlay::toggle_palette(app) {
                        log::error!("could not toggle the palette: {error}");
                    }
                }
                None => {}
            }
        })
        .build();
    if let Err(error) = app.handle().plugin(plugin) {
        log::warn!(
            "global shortcuts are unavailable; Relay is still reachable from the tray. ({error})"
        );
        return;
    }

    let handle = app.handle();
    let saved = stored(handle);
    let bindings: Vec<(Action, Binding)> = Action::ALL
        .into_iter()
        .map(|action| {
            let accelerator = saved
                .get(action.key())
                .cloned()
                .unwrap_or_else(|| action.default_accelerator().to_owned());
            (action, bind(handle, accelerator))
        })
        .collect();
    for (action, binding) in &bindings {
        if binding.status != Status::Active {
            report_broken(handle, *action, binding);
        }
    }
    *app.state::<Shortcuts>().0.lock().unwrap() = bindings;
}

/// Every action with its combination and whether it works.
pub fn list(app: &AppHandle) -> Vec<ShortcutInfo> {
    app.try_state::<Shortcuts>().map_or_else(Vec::new, |state| {
        state
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|(action, binding)| info(*action, binding))
            .collect()
    })
}

/// Rebinds `action`. On failure the old combination stays as it was, so a
/// rejected choice never leaves Relay with fewer working shortcuts.
pub fn set(app: &AppHandle, action: Action, accelerator: &str) -> Result<ShortcutInfo> {
    let accelerator = accelerator.trim().to_owned();
    let wanted = parse(&accelerator).map_err(Error::Shortcut)?;
    let state = app.state::<Shortcuts>();
    let mut bindings = state.0.lock().unwrap();
    if let Some((other, _)) = bindings
        .iter()
        .find(|(other, binding)| *other != action && binding.shortcut == Some(wanted))
    {
        return Err(Error::Shortcut(format!(
            "{accelerator} already does “{}”",
            other.label().to_lowercase()
        )));
    }
    let index = bindings
        .iter()
        .position(|(candidate, _)| *candidate == action)
        .ok_or_else(|| Error::Shortcut("global shortcuts are unavailable".into()))?;
    let previous = bindings[index].1.shortcut;
    if previous == Some(wanted) {
        return Ok(info(action, &bindings[index].1));
    }
    if let Some(previous) = previous {
        let _ = app.global_shortcut().unregister(previous);
    }
    let binding = bind(app, accelerator.clone());
    if binding.status != Status::Active {
        if let Some(previous) = previous {
            let _ = app.global_shortcut().register(previous);
        }
        return Err(Error::Shortcut(
            binding
                .message
                .unwrap_or_else(|| taken_message(&accelerator)),
        ));
    }
    bindings[index].1 = binding;
    save(app, &bindings)?;
    Ok(info(action, &bindings[index].1))
}

#[tauri::command]
pub fn shortcuts_list(app: AppHandle) -> Vec<ShortcutInfo> {
    list(&app)
}

#[tauri::command]
pub fn shortcuts_set(app: AppHandle, action: Action, accelerator: String) -> Result<ShortcutInfo> {
    set(&app, action, &accelerator)
}

#[tauri::command]
pub fn shortcuts_reset(app: AppHandle, action: Action) -> Result<ShortcutInfo> {
    set(&app, action, action.default_accelerator())
}

/// The HUD webview decides whether this opens or closes the stack, since only
/// it knows what it is showing. The core's part is making sure the window is
/// on screen to receive it: a hidden HUD means nothing was live, so this press
/// is always an open.
fn toggle_attention(app: &AppHandle) {
    if let Err(error) = crate::overlay::show_hud(app) {
        log::error!("could not show the HUD: {error}");
    }
    app.emit(AppEvent::AttentionToggleRequested);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combinations_parse_as_the_settings_screen_records_them() {
        for accelerator in [
            "Ctrl+Space",
            "Ctrl+Alt+Space",
            "Ctrl+Shift+KeyK",
            "Alt+Backquote",
            "F9",
        ] {
            assert!(parse(accelerator).is_ok(), "{accelerator}");
        }
        assert_eq!(parse("Ctrl+Shift+KeyK"), parse("ctrl+shift+k"));
    }

    #[test]
    fn a_bare_key_or_nonsense_is_refused_with_a_reason() {
        assert!(parse("KeyK")
            .unwrap_err()
            .contains("needs Ctrl, Alt, Shift or Win"));
        assert!(parse("Ctrl+Banana")
            .unwrap_err()
            .contains("not a combination"));
    }

    #[test]
    fn defaults_differ_and_parse() {
        let [palette, attention] = Action::ALL.map(|a| parse(a.default_accelerator()).unwrap());
        assert_ne!(palette, attention);
    }
}
