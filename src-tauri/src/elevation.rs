//! Lets deep links reach a Relay running as administrator.
//!
//! A `relay://` link starts a second Relay at the browser's privilege level,
//! which hands the link to the running one with `WM_COPYDATA` through the
//! single-instance plugin's hidden window. Windows drops that message when the
//! receiver has higher integrity than the sender, so the link vanishes without
//! an error. Opening that one message on that one window is the fix, and the
//! cost: any local program can now send Relay links, so callbacks must keep
//! proving themselves with their `state`.

use tauri::AppHandle;
use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::WindowsAndMessaging::{
    ChangeWindowMessageFilterEx, FindWindowW, MSGFLT_ALLOW, WM_COPYDATA,
};

use crate::events::{AppEvent, EventSink, NotificationStatus, INFO_AUTO_DISMISS_MS};

/// Runs in `setup`, after the plugin created its window. Does nothing unless
/// Relay is elevated: at normal privilege the browser's link already gets
/// through, and the filter would only open the window to sandboxed programs.
pub fn accept_links_when_elevated(app: &AppHandle) {
    if !is_elevated() {
        return;
    }
    log::warn!("Relay is running as administrator; any local program can send it relay:// links");
    if let Err(error) = allow_copydata(&app.config().identifier) {
        log::warn!("relay:// links may not reach this elevated Relay: {error}");
    }
    app.emit(AppEvent::Notification {
        // Fixed, so each elevated launch replaces the last one in the history.
        notification_id: "relay-elevated".into(),
        job_id: String::from("relay-elevated").into(),
        hue_source: "relay-elevated".into(),
        title: "Relay is running as administrator".into(),
        detail: Some("Any program on this PC can send it relay:// links.".into()),
        icon: None,
        status: NotificationStatus::Done,
        progress: None,
        auto_dismiss_ms: Some(INFO_AUTO_DISMISS_MS),
        actions: Vec::new(),
    });
}

/// The plugin names its window `{identifier}-sic` / `{identifier}-siw` (its
/// `semver` feature, which is off, would change them).
fn allow_copydata(identifier: &str) -> windows::core::Result<()> {
    let class = HSTRING::from(format!("{identifier}-sic"));
    let title = HSTRING::from(format!("{identifier}-siw"));
    unsafe {
        let window = FindWindowW(&class, &title)?;
        ChangeWindowMessageFilterEx(window, WM_COPYDATA, MSGFLT_ALLOW, None)
    }
}

fn is_elevated() -> bool {
    let mut token = HANDLE::default();
    let mut elevation = TOKEN_ELEVATION::default();
    let mut written = 0;
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let queried = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut written,
        );
        let _ = CloseHandle(token);
        queried.is_ok() && elevation.TokenIsElevated != 0
    }
}
