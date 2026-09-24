use crate::error::{Error, Result};

const SERVICE: &str = "relay-runtime-grafana";
const ACCOUNT: &str = "service-account-token";

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|error| Error::TokenStore(error.to_string()))
}

#[tauri::command]
pub fn runtime_grafana_token_configured() -> Result<bool> {
    match entry()?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(Error::TokenStore(error.to_string())),
    }
}

#[tauri::command]
pub fn runtime_grafana_set_token(token: String) -> Result<()> {
    let token = token.trim();
    if token.is_empty() {
        return Err(Error::GrafanaTokenEmpty);
    }

    entry()?
        .set_password(token)
        .map_err(|error| Error::TokenStore(error.to_string()))
}

#[tauri::command]
pub fn runtime_grafana_clear_token() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(Error::TokenStore(error.to_string())),
    }
}
