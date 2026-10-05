# 01: Adopt the Nexus Rust SDK

**What to build:** Replace Relay's hand-rolled Nexus auth, WebSocket, inbox and vault code with `nexus-client` (Nexus `sdk/rust`). Spec: Nexus `.scratch/unified-auth/spec.md` D2, D5, D7, D8, D10, D17.

**Blocked by:** Nexus 12

**Status:** human-review

**Where:** `src-tauri/src/nexus_auth.rs`, `src-tauri/src/github/events.rs`, `src-tauri/src/github/nexus_store.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src/app/core/nexus-account.ts`, `docs/nexus-connector-redesign.md`.

- [x] Single sign-in path: "Sign in with Nexus" opens the hosted page; remove the in-app email/password/MFA form, `/auth/login` bootstrap-bearer hack (which leaves an orphaned session) and Google auth-transaction handoff.
- [x] Sign-out revokes the Nexus session (SDK `sign_out`), with an optional "everywhere".
- [x] Nexus base URL from config (default `https://nexus.eresea.net`), not a constant.
- [x] GitHub connector: Relay keeps Device Flow + API logic; the token bundle is persisted with the SDK `connections` API (auto-granted), and an existing account-level GitHub connection from another app is offered via the consent flow.
- [x] Events: SDK event stream with per-installation cursor replaces leased claims; notifications de-duplicated through Nexus push where applicable.
- [x] Handle `session.revoked` by returning to the signed-out state without errors.
- [ ] `cargo check`, `npm test`, and the manual E2E checklist in `docs/nexus-connector-redesign.md` updated and passing against staging.

## Comments

- SDK is vendored in `packages/nexus-client-rs` (Nexus `d428e49`, see `SOURCE`; refresh with `scripts/sync-nexus-client.sh`), path dependency from `src-tauri/Cargo.toml`. Versions unify: one reqwest 0.12, tokio, keyring 3, tokio-tungstenite 0.24 (the pre-existing reqwest 0.13 comes from `tauri-plugin-updater`). Relay's own `tokio-tungstenite` and `futures-util` dependencies were dropped (unused now).
- Base URL: the SDK takes the API base (issuer), so the default is `https://nexus.eresea.net/api/v1`, overridable with `RELAY_NEXUS_ISSUER` or `nexus.issuer` in `settings.json`, read at startup (no restart-free switching, no settings UI).
- Keychain migration: not migrated, cleared. The old entry has the same service/account and a JSON shape the SDK can parse, but it was issued without the `connections` scope and refresh cannot widen scope. The legacy entry (has `userId`) is revoked best-effort and deleted; the user signs in once. Documented in `docs/nexus-connector-redesign.md`.
- The SDK does not surface the `credentials.granted` WebSocket event, so after `request_grant` the UI polls `github_adopt_connection` every 3 s for up to 10 minutes. Switch to the event if the SDK exposes it.
- GitHub connection is also loaded automatically on a fresh sign-in (another installation's connection, auto-granted to Relay). Disconnect does not delete the Nexus connection (apps cannot; the account page can), so the next sign-in transition re-loads it.
- Push-based notification de-duplication is not wired: Nexus issue 11 deferred event-triggered push. Local de-dupe by delivery marker is unchanged. Relay does not register a push token.
- `nexus_sync.rs` does not depend on the removed auth code and is untouched. `runtime.rs` still probes `https://nexus.eresea.net/readyz` (hard-coded; not part of auth).
- Not done here: live E2E against staging Nexus/GitHub (checklist in `docs/nexus-connector-redesign.md` is updated but unticked), so the last box stays open.
- Pre-existing failures on the base commit, unrelated: `npm test` has 3 failures in `projects.spec.ts` (2) and `update-center.spec.ts` (1) (`home.spec.ts` also failed on base and now passes); `cargo clippy -- -D warnings` fails on `derivable_impls` in `github/rules.rs` (newer clippy); `npm run lint` fails parsing `packages/umbra` files; `prettier --check` fails on 39 files including `home.ts` and `packages/umbra`; the Angular CLI refuses the installed Node 22.22.2 (needs >= 22.22.3), so Angular commands were run with Node 24.21.0.
