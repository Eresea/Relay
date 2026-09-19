//! The tray icon — Relay's only permanently visible surface.

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App,
};

#[cfg(desktop)]
pub fn build(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Relay", true, None::<&str>)?;
    let palette = MenuItem::with_id(app, "palette", "Command palette", true, Some("Ctrl+Space"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit Relay", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&palette, &open, &quit])?;

    TrayIconBuilder::with_id("relay")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("Relay")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let result = match event.id().as_ref() {
                "open" => crate::overlay::show_main(app),
                "palette" => crate::overlay::toggle_palette(app),
                "quit" => {
                    app.exit(0);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                log::error!("tray menu action failed: {error}");
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Err(error) = crate::overlay::toggle_palette(tray.app_handle()) {
                    log::error!("tray click failed: {error}");
                }
            }
        })
        .build(app)?;

    Ok(())
}
