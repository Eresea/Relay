# Relay connectors with Nexus as vault and inbox

## Decision

Relay owns each connector: provider authorization, refresh, API calls, webhook registration, payload interpretation, and notification rules. Nexus stores encrypted credentials and accepted events for an authenticated user and OAuth client. A new provider should require Relay code and configuration, not a new Nexus provider integration.

```text
Relay GitHub login ──credential deposit──▶ Nexus vault ──granted read/replace──▶ Relay core ──GitHub API
Relay core ──registers selected repo hook──▶ GitHub ──signed webhook──▶ Nexus generic ingress
Nexus inbox ──poll/ack──▶ Relay core ──rules + local notification/PR state
Nexus WebSocket ──optional inbox wakeup──▶ Relay core
```

Nexus login enables these connected features. Relay's local features still start without it.

## What exists

- Relay's GitHub Device Flow, token refresh, API client, PR diff/rules, notification pipeline, and keychain token are in `src-tauri/src/github`. Relay has Nexus account sign-in and a generic vault handoff; Relay deposits the GitHub token bundle with create-only permission and uses Nexus after the explicit read grant is approved.
- Nexus has browser authorization code + PKCE for the `relay` client (`relay://auth/callback`). Relay requests `openid profile email credentials:create`; Nexus vault creation and grant management require `credentials:manage`, currently assigned to `roots-web`. Granted clients can read a credential and can replace its secret only with an explicit replace grant.
- Nexus event endpoints are bound to `(user_id, client_id)`. Ingress supports both the existing `X-Nexus-*` HMAC and generic raw-body HMAC; accepted JSON is stored in the shared client inbox and erased on ack. A new delivery publishes a payload-free `events.available` wakeup to the authenticated OAuth client's user WebSocket.

## Implemented flow

- Relay lists GitHub repositories and registers hooks only after the user explicitly selects them. It creates one generic Nexus endpoint per repo, sends the one-time endpoint secret directly to GitHub, and stores only endpoint and hook IDs in Relay settings. Disconnect removes the GitHub hooks and revokes their Nexus endpoints.
- Relay claims inbox events on startup and every 20 seconds, and drains immediately after an authenticated WebSocket wakeup. Delivery IDs and derived notifications are committed atomically to Relay's SQLite store before Nexus ack. Unsupported, malformed, and rule-suppressed deliveries get a durable ignored marker before ack.
- Supported pull request actions refresh the current PR snapshot before notification, so the existing polling cache reconciles without repeating the opened/closed/merged/review-requested alert. Polling remains active for CI state and repositories without registered hooks.
- The WebSocket uses an Authorization header and no token in its URL. Nexus binds the subscription to the verified token client ID, not an `appId` query value. Relay closes and reconnects when the local Nexus session changes.

## Verification boundary

The Relay Rust target passes `cargo check --offline`, and Nexus passes `go build ./...`. The Angular CLI is not installed in this worktree, and no live OAuth consent, GitHub hook registration, delivery, or offline replay has been exercised here.

## Credential flow

1. Add Relay's Nexus account session in Rust using the existing Nexus browser PKCE flow. Keep Nexus access/refresh tokens in the OS credential store; redirects carry only the one-time code and state. Clear connector secrets in memory on account switch, logout, or failed refresh.
2. Relay performs GitHub Device Flow as it does today. Add a generic, owner-authorized **create-only** vault permission for the Relay OAuth client so Rust can deposit the resulting token bundle under the signed-in Nexus user. Creation gives Relay no implicit read grant; the user approves a read and, for refresh, replace grant in Nexus. This is a small Nexus authorization change, with no GitHub knowledge.
3. Store a versioned provider token bundle as the _secret_. Store only non-secret account label and provider type as metadata. Select it by Nexus user ID and credential ID, not by “first GitHub credential,” so account changes cannot silently select a different token. Fetch it into Rust only when needed; never expose it through Tauri or Angular.
4. Relay refreshes the provider token and replaces the secret plus expiry using its explicit grant. Add a generic revision/ETag precondition to replacement so two Relay installations cannot silently overwrite each other's refreshed tokens. A failed provider refresh or lost rotated token requires reconnect. Revoking the Nexus grant stops future reads; it cannot invalidate a token already issued by GitHub, so provider disconnection must also revoke it at the provider when available.
5. Migrate an existing keychain token only after Nexus sign-in, grant approval, and a successful vault readback. Then delete that local GitHub token. Keep the current local connector working until migration completes; do not maintain two permanent token sources.

## Direct webhook flow

The current Nexus HMAC format cannot accept GitHub's native webhook request. GitHub signs the **raw body** with `X-Hub-Signature-256`; it does not send the `X-Nexus-*` timestamp/signature envelope. A desktop Relay process cannot validate and forward a webhook while it is closed. The smallest generic extension is a second endpoint authentication mode. [GitHub signature contract](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

- Nexus accepts `hmac-sha256-raw-body` with configured signature, delivery ID, and event type header names. Relay supplies those names when creating an endpoint. Nexus generates one high-entropy **printable** secret, returns it once, stores it encrypted, and verifies the literal secret bytes in constant time against the exact request body. The existing Nexus HMAC mode stays available for senders Relay controls.
- Relay creates one endpoint for each selected GitHub repository hook, immediately gives its callback URL and secret to GitHub, and records the endpoint/hook IDs. If registration fails, revoke the unused endpoint; on disconnect, remove the provider hook and revoke the endpoint. The endpoint ID, never a sender-supplied user ID, determines the Nexus user and OAuth client.
- Nexus validates HMAC and size before inserting JSON into the inbox, applies per-endpoint rate/queue limits, and returns success only after the insert commits. It stores only bounded delivery/event headers. GitHub's body signature does **not** authenticate those headers, so Relay treats them as hints and interprets the body itself. No GitHub payload parser or GitHub-specific route belongs in Nexus.

This generic mode covers providers with the same raw-body HMAC primitive. A provider with incompatible signing needs a connector-owned always-on verifier/forwarder; adding a configurable signing language to Nexus would be more complexity than the first connector needs.

## Inbox processing

- Relay drains the inbox on startup, reconnect, and a modest periodic interval. A future Nexus WebSocket `events.available` message can trigger the same drain after the database commit. The socket is opened from Rust with an Authorization header, not a token in the URL. Bind inbox wakeups to the validated token's client ID; do not trust an `appId` query parameter for authorization. Wakeups contain no webhook payload.
- Treat a webhook as an event, then use Relay's provider logic to decide whether to notify and refresh the PR snapshot. Persist the processed event ID and any derived local notification atomically in Relay's existing SQLite notification store **before** acknowledging Nexus. A retry sees the marker and only repeats the ack. A transient failure leaves the event pending; an unsupported or permanently malformed event is recorded as ignored and acked so it cannot block the queue.
- GitHub can deliver out of order. Use event action for the notification and a targeted API fetch for current PR state. Keep the existing PR rules and notification presentation. Reconciliation must not repeat a notification already produced from a webhook.
- The current inbox is shared by all installations of the same user and OAuth client, and the first ack erases the payload. Treat it as **one account-level delivery**: add a generic claim/lease so only one Relay installation processes an event, while all connected installations may receive the wakeup. Per-install delivery cursors are a separate change if every device must show its own copy. A WebSocket broadcast alone does not solve this.

## GitHub coverage and recovery

Create repository hooks only for explicitly selected repositories where the user has admin access. GitHub's existing `repo` OAuth scope already includes repository webhook write access, along with broad private repository read/write access; hook creation still requires the user to have repository admin access. A future GitHub App could narrow the connector's permissions. Relay currently finds PRs the user is involved in across repositories, so hooks cannot cover that whole set. Keep ETag-based GitHub polling for repositories without hook access and as periodic reconciliation for hooked repositories. [GitHub hook permissions](https://docs.github.com/en/rest/repos/webhooks), [OAuth scope details](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

“Offline replay” means events that Nexus **accepted** while Relay was closed. GitHub does not automatically redeliver failed webhook requests, and Nexus currently caps payloads at 1 MiB while GitHub allows much larger payloads. Preserve failed-delivery visibility and use GitHub redelivery while it is available; polling can recover current PR state but cannot reconstruct every intermediate action. Do not promise a complete history across a Nexus outage or oversized webhook. [GitHub failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries), [GitHub payload cap](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

## Work order

1. **Nexus session in Relay.** Browser PKCE, token refresh/logout, core-only token handling, account identity, and offline startup. Reuse the existing Nexus HTTP transport where it fits.
2. **Generic vault handoff.** Add create-only authorization and conditional secret replacement to Nexus; deposit, approve, read, refresh, and migrate one GitHub account in Relay.
3. **Generic raw-body ingress.** Add the bounded HMAC mode, endpoint lifecycle, and verified test delivery without provider-specific Nexus code.
4. **Relay inbox consumer.** Add a generic Nexus claim/lease, then durable local event IDs, ack-after-commit, rule mapping, targeted PR refresh, and poison-event handling. Confirm one account-level delivery with two open Relay instances.
5. **GitHub hook registration.** Start with one admin-controlled repository. Keep polling for other repositories and reconciliation; cover redelivery and disconnect cleanup.
6. **Realtime hint.** Publish an inbox wakeup after insertion and let Relay drain on it. Periodic drain remains the recovery path.

## Acceptance

- GitHub auth and refresh stay in Relay; Nexus stores the opaque token under the correct user and grants only the authorized OAuth client read/replace access.
- A signed GitHub event goes to the correct user's Relay inbox, survives Relay being closed, yields one durable local notification decision, and is acked after that decision commits.
- A duplicate delivery or failed ack does not duplicate a notification. Logout, grant revocation, endpoint revocation, and provider disconnect have distinct, visible effects.
- Hook-ineligible repositories continue to get PR updates through reconciliation. Nexus outage, oversized payload, and simultaneous-device behavior are reported according to the limits above.
