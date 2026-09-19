mod commands;
mod error;
mod overlay;
#[cfg(desktop)]
mod shortcuts;
#[cfg(desktop)]
mod tray;

use tauri::WindowEvent;

pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // A second launch must raise the running instance, not start a rival
        // one that fights over the global shortcut and the tray icon.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = overlay::show_main(app) {
                log::error!("could not raise the running instance: {error}");
            }
        }));
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::core_commands,
            commands::run_core_command,
            commands::dismiss_palette,
            commands::toggle_palette,
        ])
        .on_window_event(|window, event| {
            // The palette is a spotlight, not a window: losing focus dismisses
            // it. Closing any overlay hides it instead of destroying it, so the
            // next open is instant.
            match event {
                WindowEvent::Focused(false) if window.label() == overlay::PALETTE => {
                    let _ = window.hide();
                }
                WindowEvent::CloseRequested { api, .. } if window.label() != overlay::MAIN => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            {
                tray::build(app)?;
                shortcuts::register(app);
            }

            // The main window is created hidden so that launching Relay at
            // login does not throw a window in the user's face. The tray and
            // the global shortcut are the entry points.
            if std::env::args().any(|arg| arg == "--show") {
                let _ = overlay::show_main(app.handle());
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Relay");
}
