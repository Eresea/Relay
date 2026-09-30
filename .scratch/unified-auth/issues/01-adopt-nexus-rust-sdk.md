# 01: Adopt the Nexus Rust SDK

**What to build:** Replace Relay's hand-rolled Nexus auth, WebSocket, inbox and vault code with `nexus-client` (Nexus `sdk/rust`). Spec: Nexus `.scratch/unified-auth/spec.md` D2, D5, D7, D8, D10, D17.

**Blocked by:** Nexus 12

**Status:** agent-ready

**Where:** `src-tauri/src/nexus_auth.rs`, `src-tauri/src/github/events.rs`, `src-tauri/src/github/nexus_store.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src/app/core/nexus-account.ts`, `docs/nexus-connector-redesign.md`.

- [ ] Single sign-in path: "Sign in with Nexus" opens the hosted page; remove the in-app email/password/MFA form, `/auth/login` bootstrap-bearer hack (which leaves an orphaned session) and Google auth-transaction handoff.
- [ ] Sign-out revokes the Nexus session (SDK `sign_out`), with an optional "everywhere".
- [ ] Nexus base URL from config (default `https://nexus.eresea.net`), not a constant.
- [ ] GitHub connector: Relay keeps Device Flow + API logic; the token bundle is persisted with the SDK `connections` API (auto-granted), and an existing account-level GitHub connection from another app is offered via the consent flow.
- [ ] Events: SDK event stream with per-installation cursor replaces leased claims; notifications de-duplicated through Nexus push where applicable.
- [ ] Handle `session.revoked` by returning to the signed-out state without errors.
- [ ] `cargo check`, `npm test`, and the manual E2E checklist in `docs/nexus-connector-redesign.md` updated and passing against staging.
