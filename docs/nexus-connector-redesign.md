# Relay connectors with Nexus as vault and inbox

## Decision

Relay owns each connector: provider authorization, refresh, API calls, webhook registration, payload interpretation, and notification rules. Nexus stores encrypted credentials and accepted events for an authenticated user and OAuth client. A new provider should require Relay code and configuration, not a new Nexus provider integration.

```text
Relay GitHub login ──credential deposit──▶ Nexus vault ──granted read/replace──▶ Relay core ──GitHub API
Relay core ──registers selected repo hook──▶ GitHub ──signed webhook──▶ Nexus generic ingress
Nexus inbox ──claim/ack──▶ Relay core ──rules + local notification/PR state
Nexus WebSocket ──inbox wakeup──▶ Relay core
```

Nexus login enables these connected features. Relay's local features still start without it.

## What exists

- Relay's GitHub Device Flow, token refresh, API client, PR diff/rules, notification pipeline, and keychain token are in `src-tauri/src/github`. Relay has Nexus account sign-in and a generic vault handoff; Relay deposits the GitHub token bundle with create-only permission and uses Nexus after the explicit read grant is approved.
- Nexus has browser authorization code + PKCE for the `relay` client (`relay://auth/callback`). Relay requests `openid profile email credentials:create credentials:grant:self`. It can create credentials and grant or revoke access only for credentials it created, while `credentials:manage` remains restricted to user-facing administration. Granted clients can read a credential and can replace its secret only with an explicit replace grant.
- Nexus event endpoints are bound to `(user_id, client_id)`. Ingress supports both the existing `X-Nexus-*` HMAC and generic raw-body HMAC; accepted JSON is stored in the shared client inbox and erased on ack. A new delivery publishes a payload-free `events.available` wakeup to the authenticated OAuth client's user WebSocket.

## Implemented flow

- Relay lists GitHub repositories and registers hooks only after the user explicitly selects them. It creates one generic Nexus endpoint per repo, sends the one-time endpoint secret directly to GitHub, and stores only endpoint and hook IDs in Relay settings. Disconnect removes the GitHub hooks and revokes their Nexus endpoints.
- Relay drains claimed inbox events after WebSocket connection and each authenticated `events.available` wakeup. It acknowledges only after persisting the delivery marker and any notification; unsupported and rule-suppressed deliveries get a durable ignored marker first.
- Repository hooks cover `pull_request` and `check_run`, mapping the app's PR lifecycle, review request, and CI notification rules. Existing hooks are upgraded when Relay reconnects to Nexus.
- Relay sends WebSocket pings, checks for session changes, and reconnects with backoff. It drains the durable Nexus inbox after reconnect so missed wakeups do not lose accepted deliveries.
- Linear uses a separate PKCE flow in Relay and stores its user and optional agent token bundles in the Nexus vault. Each device discovers grants for the signed-in Nexus user, refreshes locally, then updates the shared secret with an ETag so concurrent refreshes merge the latest token and per-device Codex links. Disconnect revokes Relay's shared grant; pause stays local to the device.

## Verification boundary

Local compilation does not prove live OAuth consent, hook registration, WebSocket reconnect, or offline delivery. Those still need an end-to-end run against GitHub and Nexus.

## Coverage and limits

- Hooks are created for repositories the user selects and can administer. Relay requests `pull_request` and `check_run`, covering its current PR lifecycle, review-requested, and CI passed/failed notification rules. GitHub's repository webhook API supports adding these event subscriptions to an existing hook without replacing its configuration. [GitHub webhook API](https://docs.github.com/en/rest/repos/webhooks)
- PR event payloads drive notifications; Relay fetches current PR/check state from GitHub for accurate details. GitHub API calls also refresh expiring GitHub tokens. Relay no longer runs a recurring GitHub search poll.
- Relay drains the Nexus inbox after startup/reconnect and on `events.available`; the WebSocket carries only a wakeup. Nexus retains accepted events while Relay is offline, but the inbox is account-level, so one Relay installation claims each event.
- This does not cover every webhook type GitHub offers, only the event categories already exposed by Relay's notification settings. Deliveries GitHub cannot get to Nexus (for example during a Nexus outage or for an oversized payload) are not in the durable inbox and need GitHub redelivery.

## Verification boundary

`cargo check --offline` verifies the Relay Rust target compiles. Live OAuth, hook registration, WebSocket reconnection, GitHub delivery, and offline replay still require an end-to-end run against GitHub and Nexus.
