//! Overlay window behaviour.
//!
//! Relay's overlays are created once at startup and then shown and hidden, never
//! created and destroyed. Recreating a webview costs hundreds of milliseconds,
//! which is exactly the delay that makes a launcher feel like an application
//! rather than part of the desktop.

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::error::{Error, Result};

pub const PALETTE: &str = "palette";
pub const HUD: &str = "hud";
pub const MAIN: &str = "main";

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
    win.unminimize()?;
    win.set_focus()?;
    Ok(())
}

pub fn hide_hud(app: &AppHandle) -> Result<()> {
    window(app, HUD)?.hide()?;
    Ok(())
}
