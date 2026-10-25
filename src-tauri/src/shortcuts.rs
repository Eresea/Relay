//! Global shortcuts: one opens the palette, one opens the attention stack.
//!
//! Registration can fail when another application already owns a
//! combination. That is a normal condition on a busy desktop, not a crash:
//! Relay logs it and stays usable from the tray. Each shortcut registers on
//! its own, so losing one never costs the other.

#[cfg(desktop)]
use tauri::App;

#[cfg(desktop)]
pub fn register(app: &App) {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let palette = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
    // Not Ctrl+. — a global shortcut is taken from every other application,
    // and that one is the quick-fix key in most code editors.
    let attention = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    let handle = app.handle().clone();

    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |_app, shortcut, event| {
            // Fire on press only; without this every toggle runs twice per
            // keystroke and appears not to work at all.
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if *shortcut == attention {
                toggle_attention(&handle);
            } else if let Err(error) = crate::overlay::toggle_palette(&handle) {
                log::error!("could not toggle the palette: {error}");
            }
        })
        .build();
    if let Err(error) = app.handle().plugin(plugin) {
        log::warn!(
            "global shortcuts are unavailable; Relay is still reachable from the tray. ({error})"
        );
        return;
    }

    for (shortcut, name) in [(palette, "Ctrl+Space"), (attention, "Ctrl+Alt+Space")] {
        if let Err(error) = app.global_shortcut().register(shortcut) {
            log::warn!(
                "global shortcut {name} is unavailable — another application probably owns it. \
                 ({error})"
            );
        }
    }
}

/// The HUD webview decides whether this opens or closes the stack, since only
/// it knows what it is showing. The core's part is making sure the window is
/// on screen to receive it: a hidden HUD means nothing was live, so this press
/// is always an open.
#[cfg(desktop)]
fn toggle_attention(app: &tauri::AppHandle) {
    use crate::events::{AppEvent, EventSink};

    if let Err(error) = crate::overlay::show_hud(app) {
        log::error!("could not show the HUD: {error}");
    }
    app.emit(AppEvent::AttentionToggleRequested);
}
