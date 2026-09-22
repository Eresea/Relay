//! Overlay window behaviour.
//!
//! Relay's overlays are created once at startup and then shown and hidden, never
//! created and destroyed. Recreating a webview costs hundreds of milliseconds,
//! which is exactly the delay that makes a launcher feel like an application
//! rather than part of the desktop.

use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};

pub const PALETTE: &str = "palette";
pub const HUD: &str = "hud";
pub const MAIN: &str = "main";

const HUD_TOP_OFFSET_KEY: &str = "hud.topOffset";
const DEFAULT_HUD_TOP_OFFSET: i32 = 80;
const MAX_HUD_TOP_OFFSET: i64 = 2_000;

fn window(app: &AppHandle, label: &'static str) -> Result<WebviewWindow> {
    app.get_webview_window(label)
        .ok_or(Error::MissingWindow(label))
}

/// Shows the palette centred on the monitor holding the cursor, so it appears
/// where the user is looking on a multi-monitor desk rather than always on the
/// primary display.
pub fn show_palette(app: &AppHandle) -> Result<()> {
    let win = window(app, PALETTE)?;

    if let Ok(Some(monitor)) = app
        .cursor_position()
        .and_then(|p| app.monitor_from_point(p.x, p.y))
    {
        let screen = monitor.size();
        let size = win.outer_size()?;
        let origin = monitor.position();

        let x = origin.x + ((screen.width as i32 - size.width as i32) / 2);
        // Slightly above centre: a centred overlay reads as lower than it is.
        let y = origin.y + ((screen.height as f64 * 0.28) as i32);
        win.set_position(tauri::PhysicalPosition::new(x, y))?;
    }

    win.show()?;
    win.set_focus()?;
    Ok(())
}

pub fn hide_palette(app: &AppHandle) -> Result<()> {
    window(app, PALETTE)?.hide()?;
    Ok(())
}

/// Ctrl+Space on an already-open palette closes it. A launcher that only opens
/// forces the user to reach for Escape to undo a mistaken keystroke.
pub fn toggle_palette(app: &AppHandle) -> Result<()> {
    let win = window(app, PALETTE)?;
    if win.is_visible().unwrap_or(false) {
        win.hide()?;
        Ok(())
    } else {
        show_palette(app)
    }
}

pub fn show_main(app: &AppHandle) -> Result<()> {
    let win = window(app, MAIN)?;
    win.show()?;
    #[cfg(desktop)]
    win.unminimize()?;
    win.set_focus()?;
    Ok(())
}

/// Brings the HUD on screen in the top-right of the monitor holding the
/// cursor, with a persisted top offset, and
/// never takes focus: the HUD reports on work, it is not somewhere to type.
///
/// A job reports many times over its life, so this returns early when the
/// window is already up: repositioning under every progress update would make
/// the overlay jitter across the screen while it counted.
pub fn show_hud(app: &AppHandle) -> Result<()> {
    let win = window(app, HUD)?;
    if win.is_visible().unwrap_or(false) {
        return Ok(());
    }

    if let Ok(Some(monitor)) = app
        .cursor_position()
        .and_then(|p| app.monitor_from_point(p.x, p.y))
    {
        const MARGIN: i32 = 24;
        let screen = monitor.size();
        let size = win.outer_size()?;
        let origin = monitor.position();

        let x = origin.x + screen.width as i32 - size.width as i32 - MARGIN;
        let y = origin.y + hud_top_offset(app);
        win.set_position(tauri::PhysicalPosition::new(x, y))?;
    }

    win.show()?;
    Ok(())
}

pub fn hide_hud(app: &AppHandle) -> Result<()> {
    window(app, HUD)?.hide()?;
    Ok(())
}

fn hud_top_offset(app: &AppHandle) -> i32 {
    app.store("settings.json")
        .ok()
        .and_then(|store| store.get(HUD_TOP_OFFSET_KEY))
        .and_then(|value| value.as_i64())
        .map(|offset| offset.clamp(0, MAX_HUD_TOP_OFFSET) as i32)
        .unwrap_or(DEFAULT_HUD_TOP_OFFSET)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_offset_defaults_and_stays_bounded() {
        assert_eq!(DEFAULT_HUD_TOP_OFFSET, 80);
        assert_eq!((-1_i64).clamp(0, MAX_HUD_TOP_OFFSET), 0);
        assert_eq!((2_001_i64).clamp(0, MAX_HUD_TOP_OFFSET), 2_000);
    }
}
