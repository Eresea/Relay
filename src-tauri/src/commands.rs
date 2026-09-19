//! The IPC surface.
//!
//! Anything the frontend can ask the core to do is listed here, and nowhere
//! else. Keeping the surface small and explicit is what lets the capability
//! files stay honest.

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{Error, Result};
use crate::overlay;

/// A command contributed by the core rather than by the frontend. These are
/// merged into the palette's registry at startup.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreCommand {
    pub id: String,
    pub title: String,
    pub group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

impl CoreCommand {
    fn new(id: &str, title: &str, group: &str, icon: &str) -> Self {
        Self {
            id: id.to_owned(),
            title: title.to_owned(),
            group: group.to_owned(),
            hint: None,
            icon: Some(icon.to_owned()),
        }
    }
}

#[tauri::command]
pub fn core_commands() -> Vec<CoreCommand> {
    vec![
        CoreCommand::new("open_main", "Open Relay window", "Relay", "panel-left"),
        CoreCommand::new("hide_hud", "Dismiss status overlay", "Relay", "eye"),
    ]
}

#[tauri::command]
pub fn run_core_command(app: AppHandle, id: String) -> Result<()> {
    match id.as_str() {
        "open_main" => overlay::show_main(&app),
        "open_settings" => overlay::show_main(&app),
        "hide_hud" => overlay::hide_hud(&app),
        "quit" => {
            app.exit(0);
            Ok(())
        }
        _ => Err(Error::UnknownCommand(id)),
    }
}

#[tauri::command]
pub fn dismiss_palette(app: AppHandle) -> Result<()> {
    overlay::hide_palette(&app)
}

#[tauri::command]
pub fn toggle_palette(app: AppHandle) -> Result<()> {
    overlay::toggle_palette(&app)
}
