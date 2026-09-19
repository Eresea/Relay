//! The global shortcut that opens the palette.
//!
//! Registration can fail when another application already owns the
//! combination. That is a normal condition on a busy desktop, not a crash:
//! Relay logs it and stays usable from the tray.

#[cfg(desktop)]
use tauri::App;

#[cfg(desktop)]
pub const DEFAULT_ACCELERATOR: &str = "CmdOrCtrl+Space";

#[cfg(desktop)]
pub fn register(app: &App) {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    let accelerator = Shortcut::new(Some(Modifiers::CONTROL), Code::Space);
    let handle = app.handle().clone();

    let result = app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_shortcut(accelerator)
            .expect("the default accelerator is a valid shortcut")
            .with_handler(move |_app, _shortcut, event| {
                // Fire on press only; without this the palette toggles twice
                // per keystroke and appears not to open at all.
                if event.state() == ShortcutState::Pressed {
                    if let Err(error) = crate::overlay::toggle_palette(&handle) {
                        log::error!("could not toggle the palette: {error}");
                    }
                }
            })
            .build(),
    );

    if let Err(error) = result {
        log::warn!(
            "global shortcut {DEFAULT_ACCELERATOR} is unavailable — another application \
             probably owns it. Relay is still reachable from the tray. ({error})"
        );
    }
}
