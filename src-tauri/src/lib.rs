mod commands;
mod error;
mod events;
mod github;
mod jobs;
mod overlay;
#[cfg(desktop)]
mod shortcuts;
#[cfg(desktop)]
mod tray;
mod vault;

use tauri::{Manager, WindowEvent};

use github::client::HttpGitHubClient;
use github::GithubState;
use jobs::JobRegistry;
use vault::VaultState;

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
        // No `--show` arg: a login launch stays hidden, same as any other
        // launch — the tray and the global shortcut are the entry points.
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }

    builder
        .manage(JobRegistry::default())
        .manage(VaultState::default())
        .manage(GithubState::default())
        .manage(HttpGitHubClient::default())
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
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::generate_password,
            commands::vault_add_entry,
            commands::vault_list_entries,
            commands::vault_reveal_password,
            commands::vault_delete_entry,
            commands::vault_export,
            commands::github_status,
            commands::github_connect_start,
            commands::github_disconnect,
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

            // `visible: false` in tauri.conf.json is not honoured identically
            // on every platform — the GTK build maps both overlay windows at
            // startup regardless, while Windows keeps them hidden — so put
            // both in a known state here rather than trusting the window
            // config. Without this the palette sits open over the desktop
            // the instant Relay launches on Linux, and the HUD's behaviour
            // differs per platform before a single notification has been
            // emitted.
            if let Err(error) = overlay::hide_hud(app.handle()) {
                log::warn!("could not hide the HUD at startup: {error}");
            }
            if let Err(error) = overlay::hide_palette(app.handle()) {
                log::warn!("could not hide the palette at startup: {error}");
            }

            // The main window is created hidden so that launching Relay at
            // login does not throw a window in the user's face. The tray and
            // the global shortcut are the entry points.
            if std::env::args().any(|arg| arg == "--show") {
                let _ = overlay::show_main(app.handle());
            }

            let github_client = app.state::<HttpGitHubClient>().inner().clone();
            let job_registry = app.state::<JobRegistry>().inner().clone();
            github::resume_polling_if_connected(app.handle(), github_client, &job_registry);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Relay");
}
