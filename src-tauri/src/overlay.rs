//! Overlay window behaviour.
//!
//! Relay's overlays are created once at startup and then shown and hidden, never
//! created and destroyed. Recreating a webview costs hundreds of milliseconds,
//! which is exactly the delay that makes a launcher feel like an application
//! rather than part of the desktop.

use std::sync::{Mutex, PoisonError};

use serde::Serialize;
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

/// Which way the HUD grows from its node: toward the middle of the screen it
/// sits on, so it never opens off the edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HudSide {
    Left,
    Right,
}

/// What the HUD last asked for, in logical (CSS) pixels.
#[derive(Debug, Clone, Copy)]
struct HudLayout {
    width: f64,
    height: f64,
}

/// The core shows the HUD before the webview has measured anything (see
/// `show_hud`), so it reuses whatever the webview last asked for. One HUD per
/// process, so a static is enough.
static LAST_HUD_LAYOUT: Mutex<HudLayout> = Mutex::new(HudLayout {
    width: 360.0,
    height: 74.0,
});

/// Whether the HUD can be dragged, and where the core last put it. A move that
/// lands somewhere else was the user's, and becomes the new anchor.
struct HudPlacement {
    unlocked: bool,
    last_placed: (i32, i32),
    side: HudSide,
}

static HUD_PLACEMENT: Mutex<HudPlacement> = Mutex::new(HudPlacement {
    unlocked: false,
    last_placed: (i32::MIN, i32::MIN),
    side: HudSide::Left,
});

const MIN_HUD_SIZE: f64 = 24.0;
const MAX_HUD_WIDTH: f64 = 960.0;
const MAX_HUD_HEIGHT: f64 = 1_600.0;
/// Logical distance from the window's edge to the centre of the idle dot: the
/// frame's padding, the pill's padding, and half the dot.
const NODE_INSET: f64 = 28.0;
const HUD_ANCHOR_KEY: &str = "hud.anchor";

fn placement() -> std::sync::MutexGuard<'static, HudPlacement> {
    HUD_PLACEMENT.lock().unwrap_or_else(PoisonError::into_inner)
}

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

/// Sizes the HUD to what the webview drew and anchors it. Shows the window if
/// it is hidden.
pub fn layout_hud(app: &AppHandle, width: f64, height: f64) -> Result<HudSide> {
    if !width.is_finite() || !height.is_finite() {
        return Err(std::io::Error::other("HUD size must be finite").into());
    }
    let layout = HudLayout {
        width: width.clamp(MIN_HUD_SIZE, MAX_HUD_WIDTH),
        height: height.clamp(MIN_HUD_SIZE, MAX_HUD_HEIGHT),
    };
    *LAST_HUD_LAYOUT
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = layout;
    place_hud(app, layout)?;
    Ok(placement().side)
}

pub fn hide_hud(app: &AppHandle) -> Result<()> {
    window(app, HUD)?.hide()?;
    Ok(())
}

/// Lets the user drag the HUD (`true`) or pins it where it is (`false`).
pub fn set_hud_unlocked(unlocked: bool) {
    placement().unlocked = unlocked;
}

/// Hands the pointer to the OS so the HUD follows it. Only while unlocked.
pub fn drag_hud(app: &AppHandle) -> Result<()> {
    if placement().unlocked {
        window(app, HUD)?.start_dragging()?;
    }
    Ok(())
}

/// The HUD window moved. If the user did it, remember where.
pub fn hud_moved(app: &AppHandle, position: tauri::PhysicalPosition<i32>) {
    {
        let state = placement();
        if !state.unlocked || state.last_placed == (position.x, position.y) {
            return;
        }
    }
    let Ok(win) = window(app, HUD) else { return };
    let Ok(size) = win.outer_size() else { return };
    let mut state = placement();
    let inset = (NODE_INSET * win.scale_factor().unwrap_or(1.0)).round() as i32;
    let anchor = match state.side {
        HudSide::Left => (position.x + inset, position.y),
        HudSide::Right => (position.x + size.width as i32 - inset, position.y),
    };
    state.last_placed = (position.x, position.y);
    drop(state);
    if let Ok(store) = app.store("settings.json") {
        store.set(HUD_ANCHOR_KEY, serde_json::json!([anchor.0, anchor.1]));
    }
}

fn hud_anchor(app: &AppHandle) -> Option<(i32, i32)> {
    let value = app.store("settings.json").ok()?.get(HUD_ANCHOR_KEY)?;
    let pair = value.as_array()?;
    Some((
        pair.first()?.as_i64()? as i32,
        pair.get(1)?.as_i64()? as i32,
    ))
}

fn place_hud(app: &AppHandle, layout: HudLayout) -> Result<()> {
    let win = window(app, HUD)?;
    let visible = win.is_visible().unwrap_or(false);
    let anchor = hud_anchor(app);

    // While visible, stay on the monitor it is on: following the cursor would
    // make the overlay hop screens every time a card arrives. A saved anchor
    // names its own monitor.
    let monitor = if let Some((x, y)) = anchor {
        app.monitor_from_point(f64::from(x), f64::from(y))
            .ok()
            .flatten()
    } else if visible {
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
        let (origin, side) = hud_origin(
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
            (NODE_INSET * scale).round() as i32,
            hud_top_offset(app),
            anchor,
        );
        {
            let mut state = placement();
            state.last_placed = origin;
            state.side = side;
        }
        win.set_position(tauri::PhysicalPosition::new(origin.0, origin.1))?;
    }

    if !visible {
        win.show()?;
    }
    Ok(())
}

/// Where the HUD's top-left corner goes, in physical pixels, and which way it
/// grows. `anchor` is the node's centre and the window's top; on the right half
/// of the work area the window ends at the node, on the left half it starts
/// there. The default node sits at the top-centre. Kept inside the work area.
fn hud_origin(
    (width, height): (i32, i32),
    (area_x, area_y, area_width, area_height): (i32, i32, i32, i32),
    inset: i32,
    top_offset: i32,
    anchor: Option<(i32, i32)>,
) -> ((i32, i32), HudSide) {
    let (node, top) = anchor.unwrap_or((area_x + area_width / 2, area_y + top_offset));
    let (left, side) = if node > area_x + area_width / 2 {
        (node + inset - width, HudSide::Right)
    } else {
        (node - inset, HudSide::Left)
    };
    (
        (
            left.clamp(area_x, (area_x + area_width - width).max(area_x)),
            top.clamp(area_y, (area_y + area_height - height).max(area_y)),
        ),
        side,
    )
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
    fn default_node_sits_at_the_top_centre_and_grows_right() {
        // A second monitor to the right, with a 40px top bar.
        let area = (1920, 40, 2560, 1400);
        // Exactly centred counts as the left half.
        assert_eq!(
            hud_origin((400, 74), area, 28, 12, None),
            ((3200 - 28, 52), HudSide::Left)
        );
    }

    #[test]
    fn on_the_right_half_it_grows_left_from_the_same_node() {
        let area = (0, 0, 1920, 1032);
        let node = Some((1500, 300));
        // A dot and the stack end at the same place: the node stays put.
        assert_eq!(
            hud_origin((56, 40), area, 28, 0, node),
            ((1500 + 28 - 56, 300), HudSide::Right)
        );
        assert_eq!(
            hud_origin((400, 600), area, 28, 0, node),
            ((1500 + 28 - 400, 300), HudSide::Right)
        );
    }

    #[test]
    fn on_the_left_half_it_grows_right_from_the_node() {
        let area = (0, 0, 1920, 1032);
        assert_eq!(
            hud_origin((400, 600), area, 28, 0, Some((300, 200))),
            ((272, 200), HudSide::Left)
        );
    }

    #[test]
    fn the_window_is_kept_on_screen() {
        let area = (0, 0, 1920, 1032);
        assert_eq!(
            hud_origin((400, 600), area, 28, 0, Some((1900, 900))).0,
            (1520, 432)
        );
        assert_eq!(
            hud_origin((400, 600), area, 28, 0, Some((-50, -9))).0,
            (0, 0)
        );
    }
}
