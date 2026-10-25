//! Overlay window behaviour.
//!
//! Relay's overlays are created once at startup and then shown and hidden, never
//! created and destroyed. Recreating a webview costs hundreds of milliseconds,
//! which is exactly the delay that makes a launcher feel like an application
//! rather than part of the desktop.

use std::sync::{Mutex, PoisonError};

use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};

pub const PALETTE: &str = "palette";
pub const HUD: &str = "hud";
pub const MAIN: &str = "main";

const HUD_TOP_OFFSET_KEY: &str = "hud.topOffset";
const DEFAULT_HUD_TOP_OFFSET: i32 = 0;
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

/// The attention overlay's two layouts: a one-line pill anchored top-centre,
/// and the expanded stack anchored bottom-right.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HudMode {
    Pill,
    Stack,
}

/// What the HUD last asked for, in logical (CSS) pixels.
#[derive(Debug, Clone, Copy)]
struct HudLayout {
    mode: HudMode,
    width: f64,
    height: f64,
}

/// The core shows the HUD before the webview has measured anything (see
/// `show_hud`), so it reuses whatever the webview last asked for. One HUD per
/// process, so a static is enough.
static LAST_HUD_LAYOUT: Mutex<HudLayout> = Mutex::new(HudLayout {
    mode: HudMode::Pill,
    width: 360.0,
    height: 74.0,
});

const MIN_HUD_SIZE: f64 = 24.0;
const MAX_HUD_WIDTH: f64 = 960.0;
const MAX_HUD_HEIGHT: f64 = 1_600.0;
/// Logical gap between the stack window and the work-area corner. The window
/// already carries the shadow's padding, so the glass sits further in.
const STACK_MARGIN: f64 = 4.0;

/// Brings the HUD on screen with its last layout, on the monitor holding the
/// cursor, and never takes focus: the HUD reports on work, it is not
/// somewhere to type. The webview then measures what it draws and corrects
/// the size through `layout_hud`.
///
/// A job reports many times over its life, so this returns early when the
/// window is already up.
pub fn show_hud(app: &AppHandle) -> Result<()> {
    if window(app, HUD)?.is_visible().unwrap_or(false) {
        return Ok(());
    }
    let layout = *LAST_HUD_LAYOUT
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    place_hud(app, layout)
}

/// Sizes the HUD to what the webview drew and anchors it for `mode`. Shows
/// the window if it is hidden.
pub fn layout_hud(app: &AppHandle, mode: HudMode, width: f64, height: f64) -> Result<()> {
    if !width.is_finite() || !height.is_finite() {
        return Err(std::io::Error::other("HUD size must be finite").into());
    }
    let layout = HudLayout {
        mode,
        width: width.clamp(MIN_HUD_SIZE, MAX_HUD_WIDTH),
        height: height.clamp(MIN_HUD_SIZE, MAX_HUD_HEIGHT),
    };
    *LAST_HUD_LAYOUT
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = layout;
    place_hud(app, layout)
}

pub fn hide_hud(app: &AppHandle) -> Result<()> {
    window(app, HUD)?.hide()?;
    Ok(())
}

fn place_hud(app: &AppHandle, layout: HudLayout) -> Result<()> {
    let win = window(app, HUD)?;
    let visible = win.is_visible().unwrap_or(false);

    // While visible, stay on the monitor it is on: following the cursor would
    // make the overlay hop screens every time a card arrives.
    let monitor = if visible {
        win.current_monitor().ok().flatten()
    } else {
        app.cursor_position()
            .and_then(|p| app.monitor_from_point(p.x, p.y))
            .ok()
            .flatten()
    };

    win.set_size(tauri::LogicalSize::new(layout.width, layout.height))?;
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let (x, y) = hud_origin(
            layout.mode,
            (
                (layout.width * scale).round() as i32,
                (layout.height * scale).round() as i32,
            ),
            (
                area.position.x,
                area.position.y,
                area.size.width as i32,
                area.size.height as i32,
            ),
            hud_top_offset(app),
            (STACK_MARGIN * scale).round() as i32,
        );
        win.set_position(tauri::PhysicalPosition::new(x, y))?;
    }

    if !visible {
        win.show()?;
    }
    Ok(())
}

/// Where the HUD's top-left corner goes, in physical pixels: the pill centred
/// below the top of the work area, the stack in its bottom-right corner.
fn hud_origin(
    mode: HudMode,
    (width, height): (i32, i32),
    (area_x, area_y, area_width, area_height): (i32, i32, i32, i32),
    top_offset: i32,
    margin: i32,
) -> (i32, i32) {
    match mode {
        HudMode::Pill => (area_x + (area_width - width) / 2, area_y + top_offset),
        HudMode::Stack => (
            area_x + area_width - width - margin,
            area_y + area_height - height - margin,
        ),
    }
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
    fn top_offset_stays_bounded() {
        assert_eq!((-1_i64).clamp(0, MAX_HUD_TOP_OFFSET), 0);
        assert_eq!((2_001_i64).clamp(0, MAX_HUD_TOP_OFFSET), 2_000);
    }

    #[test]
    fn pill_centres_below_the_top_of_the_work_area() {
        // A second monitor to the right, with a 40px top bar.
        let area = (1920, 40, 2560, 1400);
        assert_eq!(
            hud_origin(HudMode::Pill, (400, 74), area, 0, 6),
            (1920 + 1080, 40)
        );
        assert_eq!(
            hud_origin(HudMode::Pill, (400, 74), area, 12, 6),
            (3000, 52)
        );
    }

    #[test]
    fn stack_sits_in_the_bottom_right_of_the_work_area() {
        // Taskbar at the bottom: the work area stops above it.
        let area = (0, 0, 1920, 1032);
        assert_eq!(
            hud_origin(HudMode::Stack, (440, 600), area, 80, 6),
            (1920 - 440 - 6, 1032 - 600 - 6)
        );
    }

    #[test]
    fn mode_reads_the_frontend_wire_names() {
        let modes: Vec<HudMode> = serde_json::from_str(r#"["pill","stack"]"#).unwrap();
        assert_eq!(modes, [HudMode::Pill, HudMode::Stack]);
    }
}
