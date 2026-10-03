# Relay connectors with Nexus as vault and inbox

## Decision

Relay owns each connector: provider authorization, refresh, API calls, webhook registration, payload interpretation, and notification rules. Nexus stores the resulting credential on the user's account and the accepted events for this installation. A new provider should require Relay code and configuration, not a new Nexus provider integration.

```text
Relay GitHub Device Flow ──connections().create/replace──▶ Nexus vault (account-level connection)
Nexus vault ──read_secret──▶ Relay core ──GitHub API
Relay core ──event_endpoints().create──▶ Nexus ──signed hook URL──▶ GitHub repo hook
GitHub ──signed webhook──▶ Nexus generic ingress ──▶ per-installation inbox
Nexus WebSocket (events.available) ──▶ SDK drains inbox ──▶ Relay rules + local notification/PR state ──ack──▶ Nexus
```

Nexus sign-in enables these connected features. Relay's local features still start without it.

## Sign-in

- Relay uses the `nexus-client` SDK (vendored in `packages/nexus-client-rs`, pinned by its `SOURCE` file, refreshed with `scripts/sync-nexus-client.sh`). The crate's dependencies match Relay's (reqwest 0.12, tokio 1, keyring 3, tokio-tungstenite 0.24), so there is one copy of each.
- One path: "Sign in with Nexus" opens the Nexus-hosted page (OIDC authorization code + S256 PKCE, client `relay`, scopes `openid profile email connections`) in the system browser. The `relay://auth/callback` deep link goes to `nexus_auth::handle_callback`. Password, MFA, registration and Google handoff live on the hosted pages only.
- The session (access + refresh token) is in the OS keychain, service `relay-nexus-auth`, account `oauth-session`. The access token refreshes itself.
- Sign out revokes Relay's session. "Sign out everywhere" (account menu and account page) ends all sessions of the account. Nexus pushes `session.revoked` when a session is ended elsewhere; Relay returns to the signed-out UI without an error.
- The Nexus API base (the issuer) is `RELAY_NEXUS_ISSUER`, else `nexus.issuer` in `settings.json`, else `https://nexus.eresea.net/api/v1`. It is read at startup.

### Migrating existing installs

Relay before the SDK stored a session under the same keychain entry with the same access/refresh/expiry fields, so the JSON is technically readable. It is not migrated: that session was issued without the `connections` scope and a refresh cannot widen a token's scope, so every vault call would fail. On first start the legacy entry (recognised by its `userId` field) is revoked on Nexus (best effort) and deleted, and the user signs in once. Connector state is not lost: the GitHub pointer in `settings.json` (`github.nexusCredential`) and the local GitHub token are kept, and the GitHub credential Relay created earlier is auto-granted to Relay again after sign-in.

## GitHub connector

- Relay keeps Device Flow, token refresh and the GitHub API logic (`src-tauri/src/github`).
- Signed in, the token bundle is a `github` / `oauth-token-bundle` connection on the account, written through the SDK `connections()` API. The creating app is auto-granted read and replace. Replaces send `If-Match`; on `409 credential_revision_conflict` Relay re-reads the revision and retries.
- Signed out, the bundle stays in the local keychain. A local token found while signed in is newer than anything in Nexus, so it is uploaded and the local copy removed. After sign-in on a new installation, the GitHub connection Relay created earlier is loaded automatically.
- If the account holds a GitHub connection created by another app (`available`), Settings > GitHub offers "Use GitHub connection from <app>". It calls `request_grant` (replace access requested), opens the consent page, and the UI polls until Relay is granted, then loads it.
- Disconnect removes Relay's repo hooks and event endpoints, the local token and Relay's pointer, and deletes the `github` connection from the Nexus account (`connections().delete`, allowed for connections the app created) so every device is disconnected. The connection id is queued in `github.pending-nexus-deletes` and retried the next time GitHub status loads while signed in, so an offline or signed-out disconnect still completes later. A `404` (already gone, or created by another app, which only the account page can remove) counts as done.

## Events

- Hooks are created for repositories the user selects and can administer. Relay creates one generic Nexus endpoint per repo (`event_endpoints().create`), sends the one-time secret directly to GitHub, and stores only the endpoint and hook ids in `settings.json`. Removing a hook revokes its endpoint.
- Hooks cover `pull_request` and `check_run`, mapping the PR lifecycle, review request, and CI notification rules. Existing hooks get missing event subscriptions when Relay connects to Nexus.
- `NexusClient::events` keeps the session-bound WebSocket, drains the inbox after every connect and on `events.available`, and acknowledges (cursor-based, per Nexus session, i.e. per installation) only after Relay's handler returned `Ok`. The handler persists the delivery marker (processed, or ignored for unsupported and rule-suppressed deliveries) and any notification first, so a redelivery after a failed ack is de-duplicated locally.
- Nexus retains events while Relay is offline. Each installation has its own cursor, so two installations each receive every event. Deliveries GitHub cannot get to Nexus (Nexus outage, oversized payload) are not in the inbox and need GitHub redelivery.
- PR payloads drive notifications; Relay fetches current PR/check state from GitHub for accurate details. There is no recurring GitHub search poll.

## Linear connector

- Linear keeps its own PKCE flow in Relay (`relay://linear/...` callback) and requires a Nexus sign-in first. Tokens live per workspace in the local keychain (service `relay-linear`); Nexus is the cross-device vault.
- Signed in, each workspace's user and optional agent token bundle is a `linear` / `oauth-token-bundle` connection on the account (metadata: workspace and viewer), written through the SDK `connections()` API exactly like GitHub. Relay creates it, so it is auto-granted to Relay; no grant call, no `credentials:create` or `credentials:grant:self` scope.
- Each installation discovers `connections().granted()` entries in namespace `linear`, refreshes locally, and writes back with `If-Match`. On `409 credential_revision_conflict` it re-reads, merges (newest token, newest agent token, per-device Codex links and project policies) and retries up to three times. Settings shows a retry when a sync failed (`nexusSyncPending`).
- Connect, agent install and sync fail with a prompt to sign in when Nexus is signed out; Relay does not reintroduce an in-app login.
- Disconnect removes the workspace on this device and remembers it so discovery does not load it again until it is reconnected here. It also deletes the workspace's `linear` connection from the Nexus account (`connections().delete`, allowed for connections Relay created) so every device is disconnected. If that fails (offline, signed out) the workspace stays in the pending list and the delete is retried on the next `status()`; once deleted it leaves the list. A connection created by another app cannot be deleted by Relay; it stays hidden on this device and the user is told to remove it on the Nexus account page. Pause stays local to the device.

## Verification boundary

`cargo check`, `cargo test` and `npm test` verify compilation and Relay's own logic. The SDK is tested against a mock and, upstream, a live Nexus. Nothing here proves live sign-in, consent, hook registration, WebSocket reconnect or offline replay against Nexus and GitHub; that is the manual checklist below.

## Manual E2E checklist (staging)

Run against a staging Nexus (`RELAY_NEXUS_ISSUER=https://<staging>/api/v1`) and a real GitHub OAuth App.

- [ ] Fresh install: no in-app email/password/MFA/Google form; "Sign in with Nexus" opens the hosted page; after approval the deep link returns to Relay and the account shows your name.
- [ ] Upgrade from the previous release with a signed-in session: Relay starts signed out, old session is gone from the keychain and revoked on Nexus (account page shows no stale Relay session), sign-in works, and the GitHub connection is still connected.
- [ ] No orphaned Nexus session is created by signing in (account page lists exactly one Relay session).
- [ ] Sign out: Relay shows signed out; the session disappears from the account page. Sign out everywhere: other apps are signed out too.
- [ ] End the Relay session from the account page while Relay runs: Relay returns to signed out within seconds with no error toast.
- [ ] `RELAY_NEXUS_ISSUER` (or `nexus.issuer`) pointing at staging is honoured.
- [ ] Connect GitHub with Device Flow while signed in: a `github` connection appears on the account page; no local GitHub keychain entry remains.
- [ ] Connect GitHub while signed out, then sign in: the token moves to Nexus and the local copy is removed.
- [ ] Second installation, same account: after sign-in GitHub shows connected without Device Flow.
- [ ] Create a GitHub connection from another app (e.g. Roots); on a Relay with no GitHub connection "Use GitHub connection from <app>" appears, opens the consent page, and after approval Relay shows connected.
- [ ] Connect Linear while signed in: a `linear` connection appears on the account page; a second installation lists the workspace after sign-in; concurrent token refreshes merge without losing Codex links.
- [ ] Token refresh on two installations: no lost update (a `credential_revision_conflict` is retried, both keep working).
- [ ] Enable a webhook for a repo: GitHub shows a delivery URL under the Nexus issuer and ping succeeds; removing it deletes the hook and revokes the endpoint.
- [ ] Open, review-request and CI events produce one notification each; quit Relay, generate events, restart: they are delivered once.
- [ ] Kill Relay between marker write and ack (or drop the network mid-drain): the event is redelivered and not notified twice.
- [ ] Disconnect GitHub: hooks and endpoints are removed and the connection is deleted from the account.
- [ ] Disconnect on device A removes the connection on device B (Linear and GitHub): the connection disappears from the account page and device B no longer lists it after its next status refresh. Disconnect while offline: the delete completes on the next status refresh once online.
