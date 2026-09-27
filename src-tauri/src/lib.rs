#[cfg(desktop)]
mod codex;
mod commands;
mod error;
mod events;
mod github;
mod gmail;
mod jobs;
mod linear;
#[cfg(any(mobile, test))]
#[allow(dead_code)]
mod mobile_updates;
mod nexus_auth;
pub mod nexus_sync;
mod notifications;
mod opencloud;
mod overlay;
#[cfg(desktop)]
mod runtime;
#[cfg(desktop)]
mod shortcuts;
#[cfg(desktop)]
mod tray;
#[cfg(desktop)]
mod updates;
mod vault;
mod workspaces;

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

use github::client::HttpGitHubClient;
use gmail::GmailState;
use jobs::JobRegistry;
use linear::LinearState;
use vault::VaultState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // A second launch must raise the running instance, not start a rival
        // one that fights over the global shortcut and the tray icon.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Err(error) = overlay::show_main(app) {
                log::error!("could not raise the running instance: {error}");
            }
            for arg in args {
                if let Ok(url) = url::Url::parse(&arg) {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if url.host_str() == Some("linear") {
                            linear::handle_callback(app, url).await;
                        } else {
                            nexus_auth::handle_callback(app, url).await;
                        }
                    });
                }
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

    builder = builder
        .manage(JobRegistry::default())
        .manage(VaultState::default())
        .manage(HttpGitHubClient::default())
        .manage(GmailState::default())
        .manage(LinearState::default())
        .manage(nexus_auth::NexusAuthState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        );

    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_notification::init());
    }

    #[cfg(desktop)]
    {
        builder = builder
            .manage(updates::UpdateManager::default())
            .manage(codex::CodexState::default())
            .plugin(tauri_plugin_updater::Builder::new().build())
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
                opencloud::opencloud_connect,
                opencloud::opencloud_disconnect,
                opencloud::opencloud_status,
                opencloud::opencloud_list,
                opencloud::opencloud_create_folder,
                opencloud::opencloud_upload,
                opencloud::opencloud_delete,
                opencloud::opencloud_download,
                commands::github_status,
                commands::github_repositories,
                commands::github_register_webhooks,
                commands::github_webhook_repositories,
                commands::github_unregister_webhook,
                commands::github_pull_requests,
                commands::github_connect_start,
                commands::github_disconnect,
                commands::linear_status,
                commands::linear_oauth_configured,
                commands::linear_connect_start,
                commands::linear_disconnect,
                commands::linear_sync_connection,
                commands::linear_teams,
                commands::linear_users,
                commands::linear_issue_labels,
                commands::linear_projects,
                commands::linear_archive_project,
                commands::linear_unarchive_project,
                commands::linear_project_statuses,
                commands::linear_create_project,
                commands::linear_update_project,
                commands::linear_project_milestones,
                commands::linear_project_updates,
                commands::linear_archive_project_update,
                commands::linear_unarchive_project_update,
                commands::linear_create_project_update,
                commands::linear_update_project_update,
                commands::linear_create_milestone,
                commands::linear_update_milestone,
                commands::linear_initiatives,
                commands::linear_create_initiative_update,
                commands::linear_update_initiative_update,
                commands::linear_archive_initiative_update,
                commands::linear_unarchive_initiative_update,
                commands::linear_archive_initiative,
                commands::linear_unarchive_initiative,
                commands::linear_create_initiative,
                commands::linear_update_initiative,
                commands::linear_add_project_to_initiative,
                commands::linear_remove_project_from_initiative,
                commands::linear_cycles,
                commands::linear_create_cycle,
                commands::linear_update_cycle,
                commands::linear_workflow_states,
                commands::linear_create_issue,
                commands::linear_issue_detail,
                commands::linear_create_comment,
                commands::linear_codex_context,
                commands::linear_set_codex_project_allowed,
                commands::linear_save_codex_link,
                commands::linear_update_issue,
                commands::linear_my_issues,
                commands::linear_team_issues,
                commands::linear_project_issues,
                commands::nexus_auth_status,
                commands::nexus_auth_start,
                commands::nexus_auth_login,
                commands::nexus_auth_register,
                commands::nexus_auth_verify_email,
                commands::nexus_auth_verify_mfa,
                commands::nexus_auth_google_start,
                commands::nexus_auth_logout,
                commands::gmail_status,
                commands::gmail_get_settings,
                commands::gmail_set_settings,
                commands::gmail_connect,
                commands::gmail_cancel_connect,
                commands::gmail_disconnect,
                commands::notifications_list,
                commands::notifications_mark_read,
                commands::notifications_clear,
                commands::scan_workspaces,
                commands::open_terminal,
                commands::project_action,
                runtime::runtime_grafana_token_configured,
                runtime::runtime_grafana_set_token,
                runtime::runtime_grafana_clear_token,
                runtime::runtime_grafana_check,
                runtime::runtime_grafana_dashboard_panels,
                runtime::runtime_leaf_health,
                runtime::runtime_nexus_readiness,
                commands::codex_send,
                commands::codex_list_threads,
                commands::codex_read_thread,
                commands::codex_older_turns,
                commands::update_status,
                commands::update_check,
                commands::update_download,
                commands::update_install,
            ]);
    }

    #[cfg(not(desktop))]
    {
        builder = builder.invoke_handler(tauri::generate_handler![
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
            opencloud::opencloud_connect,
            opencloud::opencloud_disconnect,
            opencloud::opencloud_status,
            opencloud::opencloud_list,
            opencloud::opencloud_create_folder,
            opencloud::opencloud_upload,
            opencloud::opencloud_delete,
            opencloud::opencloud_download,
            commands::github_status,
            commands::github_repositories,
            commands::github_register_webhooks,
            commands::github_webhook_repositories,
            commands::github_unregister_webhook,
            commands::github_pull_requests,
            commands::github_connect_start,
            commands::github_disconnect,
            commands::linear_status,
            commands::linear_oauth_configured,
            commands::linear_connect_start,
            commands::linear_disconnect,
            commands::linear_sync_connection,
            commands::linear_teams,
            commands::linear_users,
            commands::linear_issue_labels,
            commands::linear_projects,
            commands::linear_archive_project,
            commands::linear_unarchive_project,
            commands::linear_project_statuses,
            commands::linear_create_project,
            commands::linear_update_project,
            commands::linear_project_milestones,
            commands::linear_project_updates,
            commands::linear_archive_project_update,
            commands::linear_unarchive_project_update,
            commands::linear_create_project_update,
            commands::linear_update_project_update,
            commands::linear_create_milestone,
            commands::linear_update_milestone,
            commands::linear_initiatives,
            commands::linear_create_initiative_update,
            commands::linear_update_initiative_update,
            commands::linear_archive_initiative_update,
            commands::linear_unarchive_initiative_update,
            commands::linear_archive_initiative,
            commands::linear_unarchive_initiative,
            commands::linear_create_initiative,
            commands::linear_update_initiative,
            commands::linear_add_project_to_initiative,
            commands::linear_remove_project_from_initiative,
            commands::linear_cycles,
            commands::linear_create_cycle,
            commands::linear_update_cycle,
            commands::linear_workflow_states,
            commands::linear_create_issue,
            commands::linear_issue_detail,
            commands::linear_create_comment,
            commands::linear_codex_context,
            commands::linear_set_codex_project_allowed,
            commands::linear_save_codex_link,
            commands::linear_update_issue,
            commands::linear_my_issues,
            commands::linear_team_issues,
            commands::linear_project_issues,
            commands::nexus_auth_status,
            commands::nexus_auth_start,
            commands::nexus_auth_login,
            commands::nexus_auth_register,
            commands::nexus_auth_verify_email,
            commands::nexus_auth_verify_mfa,
            commands::nexus_auth_google_start,
            commands::nexus_auth_logout,
            commands::gmail_status,
            commands::gmail_get_settings,
            commands::gmail_set_settings,
            commands::gmail_connect,
            commands::gmail_cancel_connect,
            commands::gmail_disconnect,
            commands::notifications_list,
            commands::notifications_mark_read,
            commands::notifications_clear,
            commands::mobile_update_check,
            commands::scan_workspaces,
            commands::open_terminal,
            commands::project_action,
        ]);
    }

    #[cfg(desktop)]
    {
        builder = builder.on_window_event(|window, event| {
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
                tauri::WindowEvent::Focused(false) if window.label() == overlay::PALETTE => {
                    let _ = window.hide();
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        });
    }

    builder
        .setup(|app| {
            #[cfg(windows)]
            if let Err(error) = app.deep_link().register_all() {
                log::warn!("could not register Relay deep links: {error}");
            }

            let callback_app = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let app = callback_app.clone();
                    let url = url.clone();
                    tauri::async_runtime::spawn(async move {
                        if url.host_str() == Some("linear") {
                            linear::handle_callback(app, url).await;
                        } else {
                            nexus_auth::handle_callback(app, url).await;
                        }
                    });
                }
            });
            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    let app = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        if url.host_str() == Some("linear") {
                            linear::handle_callback(app, url).await;
                        } else {
                            nexus_auth::handle_callback(app, url).await;
                        }
                    });
                }
            }
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
            #[cfg(desktop)]
            {
                if let Err(error) = overlay::hide_hud(app.handle()) {
                    log::warn!("could not hide the HUD at startup: {error}");
                }
                if let Err(error) = overlay::hide_palette(app.handle()) {
                    log::warn!("could not hide the palette at startup: {error}");
                }
            }

            // The main window is created hidden so that launching Relay at
            // login does not throw a window in the user's face. The tray and
            // the global shortcut are the entry points.
            #[cfg(desktop)]
            if std::env::args().any(|arg| arg == "--show") {
                let _ = overlay::show_main(app.handle());
            }

            github::events::start(app.handle().clone());

            // A connector that stopped polling every time the window closed
            // would be pointless — resume whatever was connected before the
            // last exit. Spawned rather than awaited: startup must not block
            // on network I/O, and a resume failure (no stored session, a
            // revoked grant, an unreachable keychain) is not fatal to Relay.
            let resume_handle = app.handle().clone();
            let resume_registry = app.state::<JobRegistry>().inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = gmail::resume(
                    resume_handle,
                    resume_registry,
                    gmail::HttpGoogleApi::new(),
                    gmail::OsKeyStore,
                )
                .await
                {
                    log::warn!("could not resume the Gmail connector: {error}");
                }
            });

            #[cfg(desktop)]
            {
                let update_manager = app.state::<updates::UpdateManager>().inner().clone();
                update_manager.start(app.handle().clone());
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Relay");
}
