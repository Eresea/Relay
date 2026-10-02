# nexus-client (Rust)

Nexus client for Tauri / native apps: OAuth authorization code + S256 PKCE, refresh token in the OS keychain (single-flight refresh), session-bound WebSocket with inbox delivery, connections (vault), event endpoints and push registration. Tauri-agnostic: the browser is opened by a callback you provide.

Dependency versions match Relay (reqwest 0.12 rustls, tokio 1, keyring 3, tokio-tungstenite 0.24). On Linux the keyring backend needs `libdbus-1-dev` and `pkg-config` to build.

```toml
nexus-client = { git = "https://github.com/<org>/Nexus", branch = "main", package = "nexus-client" }  # subdirectory sdk/rust
```

## Tauri

```rust
use std::sync::Arc;
use nexus_client::{NexusClient, NexusConfig};
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

let nexus = NexusClient::with_keyring(NexusConfig {
    issuer: "https://nexus.eresea.net/api/v1".into(),   // routes are relative to this
    client_id: "relay".into(),
    redirect_uri: "relay://auth/callback".into(),
    scopes: ["openid", "profile", "email", "connections"].map(String::from).to_vec(),
    keyring_service: "relay-nexus-auth".into(),
    keyring_account: "oauth-session".into(),
})?;
app.manage(nexus.clone());

// Deep link -> handle_callback
let n = nexus.clone();
app.deep_link().on_open_url(move |e| {
    for url in e.urls() {
        let n = n.clone();
        let url = url.to_string();
        tauri::async_runtime::spawn(async move { let _ = n.handle_callback(&url).await; });
    }
});

// Sign in: the opener gets the authorize URL
let handle = app.handle().clone();
nexus.sign_in(move |url| handle.opener().open_url(url, None::<&str>).map_err(Into::into))?;

// Auth state -> frontend
let mut rx = nexus.watch();
tauri::async_runtime::spawn(async move {
    while rx.changed().await.is_ok() { app_handle.emit("nexus://auth", format!("{:?}", *rx.borrow())).ok(); }
});

// Realtime: drained after connect and on events.available, acked after the handler succeeds
let events = nexus.events(|ev| async move { handle_event(ev).await });   // keep the handle alive

let token = nexus.access_token().await?;                 // refreshes 30 s early, single-flight
nexus.sign_out(false).await?;                            // revoke this app; true = everywhere
```

`prompt=none` (silent SSO check): `sign_in_with_prompt(Some("none"), opener)`; `handle_callback` then returns `Error::Authorization { code: "login_required", .. }` when there is no SSO session.

## Connections

```rust
let c = nexus.connections();
let cred = c.create(&CredentialInput { namespace: "github".into(), credential_type: "oauth-token-bundle".into(),
    label: "GitHub".into(), metadata: json!({}), secret: bundle_json, expires_at: None }).await?;   // auto-granted to this app
let s = c.read_secret(&cred.id).await?;
match c.replace_secret(&cred.id, &new, None, s.revision.as_deref()).await {
    Err(e) if e.is_revision_conflict() => { /* someone replaced it: re-read and retry */ }
    r => { r?; }
}
for a in c.available("github").await? {                   // created by another app
    c.request_grant(&a.id, false, |url| open_in_browser(url)).await?;   // user approves on the consent page
}
```

`nexus.event_endpoints()` (create / list / revoke) and `nexus.push()` (register / unregister a device token) follow the same pattern.

## Errors

`Error::SignedOut` means the session is gone (`invalid_grant`, `session.revoked`, close 4001) and tokens were cleared; `AuthState` also flips to `SignedOut`. Network errors and 5xx never sign out. A 401 from an API call triggers one refresh and retry.

## Tests

`cargo test` runs unit and integration tests against an in-process mock (HTTP + WebSocket). `examples/cli.rs` is a Tauri-free demo.

### Contract tests (live Nexus)

```sh
createdb nexus_contract
NEXUS_ENV=development NEXUS_HTTP_ADDR=127.0.0.1:18412 NEXUS_CLIENTS_FILE=deploy/clients.yaml \
NEXUS_DATABASE_URL='postgres://postgres:postgres@localhost:5432/nexus_contract?sslmode=disable' \
NEXUS_AUTH_ISSUER=http://127.0.0.1:18412/api/v1 NEXUS_AUTH_JWT_SIGNING_KEY=dev-only \
NEXUS_VAULT_KEY=$(head -c32 /dev/urandom | base64) NEXUS_AUTH_TOTP_ENCRYPTION_KEY=$(head -c32 /dev/urandom | base64) \
NEXUS_JOBS_ENABLED=false go run ./cmd/nexus
# register + verify a user (the verification token is in the server log), then:
NEXUS_CONTRACT_ISSUER=http://127.0.0.1:18412/api/v1 NEXUS_CONTRACT_EMAIL=... NEXUS_CONTRACT_PASSWORD=... \
  cargo test --test contract -- --ignored --test-threads=1
```

Nexus rate-limits `/oauth/*` to 10 requests per minute per IP; restart it (or wait a minute) between runs.
