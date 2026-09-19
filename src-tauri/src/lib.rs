mod commands;
mod error;
mod events;
mod jobs;
mod overlay;
#[cfg(desktop)]
mod shortcuts;
#[cfg(desktop)]
mod tray;

use tauri::WindowEvent;

use jobs::JobRegistry;

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
        .manage(JobRegistry::default())
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
            commands::cancel_job,
            commands::is_job_running,
            commands::dismiss_palette,
            commands::toggle_palette,
        ])
        .on_window_event(|window, event| {
            // The palette is a spotlight, not a window: losing focus dismisses
            // it. Closing any window hides it instead of destroying it, so the
            // next open is instant.
            //
            // This includes the main window. Destroying it would be
            // unrecoverable: every route back — the tray's "Open Relay", the
            // single-instance raise, `open_main`, `open_settings` — resolves
            // the window by label through `overlay::window`, which fails with
            // `MissingWindow` once the webview is gone. Relay lives in the
            // tray, so closing its window means "put it away", not "quit";
            // quitting is the tray's own Quit item.
            match event {
                WindowEvent::Focused(false) if window.label() == overlay::PALETTE => {
                    let _ = window.hide();
                }
                WindowEvent::CloseRequested { api, .. } => {
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
