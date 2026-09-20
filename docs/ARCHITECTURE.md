# Architecture

Relay is a Rust core with an Angular interface, packaged by Tauri. The split
is deliberate and load-bearing: the core owns everything that must survive the
interface being closed, and the interface owns nothing but what is on screen.

## The two halves

**The core (`src-tauri/`)** holds the global shortcut, the tray icon, window
lifecycle, and — as the project grows — the schedulers, watchers and agent
supervisors that keep running while no window is visible. It is the process
that is actually "Relay".

**The interface (`src/`)** is three surfaces rendered from one bundle: the
command palette, the HUD, and the main window. Which one a webview shows is
decided by a `?surface=` query parameter set in `tauri.conf.json`, so every
surface also renders in a plain browser during development.

They meet at exactly one place: `src/app/core/tauri.ts` on one side and
`src-tauri/src/commands.rs` on the other. Nothing else in the frontend calls
`invoke`, and nothing else in the core is exposed to the webview. Keeping that
surface small is what lets `src-tauri/capabilities/default.json` stay narrow —
the webview is granted almost no plugin access, because it asks the core
instead.

## Windows are created once

All three windows are created at startup and then shown and hidden. Creating a
webview costs hundreds of milliseconds, and that delay is the whole difference
between a launcher that feels like part of the desktop and one that feels like
an application being started.

Consequences, all handled in `src-tauri/src/lib.rs`:

- Closing an overlay hides it instead of destroying it (`prevent_close`).
- The palette hides when it loses focus. It is a spotlight, not a window.
- The main window starts hidden. Launching Relay at login must not throw a
  window in the user's face; the tray and the shortcut are the entry points.
  Pass `--show` to open it.

`overlay.rs` positions the palette on the monitor holding the cursor, slightly
above centre. A centred overlay reads as lower than it is.

## Commands

A command is a title, a group, an optional shortcut and a function
(`src/app/core/command.ts`). Both halves contribute them:

- Frontend features register on init and dispose on teardown, through
  `CommandRegistry`.
- The core exposes its own through `core_commands`, which the root component
  merges at startup. Their metadata is `CoreCommandMeta`
  (`src-tauri/src/commands.rs`); running one dispatches through the separate
  `CoreCommand` enum, adjacently tagged as `{ id, args }` on the wire
  (`#[serde(tag = "id", content = "args")]`). The two are deliberately
  distinct types: the frontend can list commands without being able to
  construct a bogus dispatch value, and a variant that carries data (there are
  none yet) cannot have that data silently dropped — the compiler forces every
  match arm in `run_core_command` to consume what it destructures.

The palette knows nothing about where a command came from. Adding a feature
means registering commands, not touching the palette.

Ranking is a small subsequence matcher in `core/fuzzy.ts` that favours word
starts and consecutive runs. A palette over a few hundred commands does not
need a real fuzzy-finder, and a scoring function you can read is worth more
than one that ranks marginally better.

## Events and jobs

The core can also push to the frontend, unprompted, over a single Tauri
channel (`relay://event`, defined in `src-tauri/src/events.rs`). This is how
anything long-running — a job, eventually a watcher or an agent run — reports
progress without the frontend polling for it.

`AppEvent` is internally tagged (`#[serde(tag = "type")]`) and mirrored by
hand in `src/app/core/events.ts`; there is no schema generation, so a field
added on one side and not the other is a silent bug caught only by the
wire-shape tests in `events.rs` — extend those tests along with the enum.
`TauriBridge.onEvent()` is the one place the frontend listens; `App`'s
constructor is the one place that subscribes, routing everything into
`NotificationCenter`, which owns the small state machine (queued → running →
done, with a short grace period before a finished notification is dropped)
that `HudSurface` renders.

Showing the HUD is split across the two halves, because each owns half of
the question. The core shows it — `EventSink for AppHandle` calls
`overlay::show_hud` before emitting any `Notification`, since only the core
knows a notification is about to exist. The frontend hides it — `HudSurface`
calls `hide_hud` when its queue empties, since only the frontend knows when
the grace period has run out. Nothing else shows the HUD, and rendering into
it does not make it visible: the window is created hidden, so a notification
emitted without that `show_hud` draws into a window nobody can see. That was
a real bug, and one that reproduced only off Linux — `visible: false` is not
honoured identically across platforms (the GTK build maps both the HUD and
the palette at startup anyway, Windows keeps both hidden), which is why
`setup` now hides each explicitly rather than trusting the window config to
give every platform the same starting state.

Background work itself lives in `src-tauri/src/jobs/mod.rs`. `jobs::spawn`
takes an `async` closure and runs it on `tauri::async_runtime::spawn`, not
plain `tokio::spawn` — every command in `commands.rs` is a synchronous
`#[tauri::command]`, which Tauri's codegen runs directly on the native IPC
callback thread with no Tokio runtime entered, so `tokio::spawn`'s
`Handle::current()` panics there; because that panic crosses a WebView2 FFI
boundary, it aborts the whole process instead of unwinding.
`async_runtime::spawn` owns a lazily initialized runtime handle and enters it
before spawning, so it works no matter which thread calls it. Two jobs
spawned this way still run genuinely concurrently, on whichever worker
threads Tokio's multi-threaded runtime has free; this is
covered by a test that spawns two 30ms jobs and asserts they finish in ~30ms
together, not ~60ms in sequence.

Each job gets a `JobContext`, which is how it reports progress
(`ctx.report(status, title, detail, progress)`, emitted as `AppEvent::Notification`)
and how it cooperates with cancellation. Cancellation is a shared
`Arc<AtomicBool>` per job, flipped by the `cancel_job` command; a job observes
it by calling `ctx.checkpoint()?` between steps, which returns
`Err(Error::JobCancelled)` once cancelled. This is deliberately cooperative,
not preemptive — a job that never checkpoints (an unyielding CPU-bound loop,
a blocking call) cannot be stopped this way, and that limit is documented by
its own test rather than left to be rediscovered. `JobRegistry` tracks which
job IDs are currently running (`is_job_running`) and hands out cancellation
handles; it is cloned into `AppHandle`-managed state, so any command handler
can reach it.

Testability drove one more split: jobs don't emit through `tauri::AppHandle`
directly, they emit through the `EventSink` trait, which `AppHandle`
implements for production and which tests implement with an in-memory
`FakeSink`. That makes the whole job pipeline — including the concurrency
proof above — testable with `cargo test` and no live Tauri app.

A home-directory scan (`jobs::scan`) exercised this pipeline end to end for a
while — real, unpredictable I/O rather than a sleep loop — and served its
purpose: it is what caught both the `tokio::spawn`-without-a-runtime crash and
the HUD never being shown. It has since been removed; its replacements as
the pipeline's first lasting producers are the GitHub and Gmail connectors'
poll jobs (below).

One caveat worth carrying forward: the release Cargo profile sets
`panic = "abort"`. A job spawned with `tokio::spawn` that panics currently
takes the whole Relay process down with it, rather than just failing that one
job. This was fine while the only job was a deterministic demo; it stops
being fine once jobs start shelling out to agents or external tools, and
should be revisited (most likely by catching panics at the boundary in
`jobs::spawn`) before then.

## Change detection

The app is zoneless. There is no `zone.js`; state is signals throughout and
every component is `OnPush`. This is not a micro-optimisation — an app that
sits idle in the tray all day should do no work at all when nothing changed.

## Errors

Everything crossing IPC returns `Result<T, Error>` from `src-tauri/src/error.rs`,
so the frontend can branch on a kind rather than parse a string.

Failures that are normal on a busy desktop are not crashes. If another
application already owns Ctrl+Space, Relay logs a warning and stays reachable
from the tray. A launcher that refuses to start because a shortcut is taken is
a worse launcher.

## Password vault

`src-tauri/src/vault.rs` is the first thing in Relay that persists a secret.
Entries (`VaultEntry`: label, username, password, optional URL/notes) live on
disk as one AES-256-GCM ciphertext (`vault.json` in the app-data directory),
keyed by an Argon2id hash of a master password plus a random salt stored
alongside it. There is no password reset — losing the master password loses
the vault, by design; a recovery path would be a second way in.

Decrypted entries exist only in memory (`VaultState`, Tauri-managed), only
while unlocked. Listing entries returns `VaultEntrySummary` — everything but
the password — so a rendered list never puts every plaintext secret into the
DOM at once; a password crosses IPC again, on demand, through
`reveal_password`. GCM's authentication tag doubles as the wrong-password
check, so unlocking needs no separate verifier on disk. `generate_password`
is pure and stateless, so the palette's password generator works before a
vault even exists. `export` writes a second, still-encrypted `VaultFile` to
the user's documents folder — a portable backup, not a plaintext dump.

The frontend surface is `src/app/features/vault/vault.ts`, reached the same
way Settings is: a palette command dispatches `CoreCommand::OpenVault`, which
shows the main window and emits `AppEvent::OpenVaultRequested` for `Home` to
switch views to, since the palette and the main window are separate webviews
with no shared JS state.

## GitHub connector

`src-tauri/src/github/` is one of Relay's first two external service
connectors, alongside Gmail (below). It is split by concern rather than
kept in one file, the way `vault.rs` is, because there is more surface area
to test in isolation:

- `oauth.rs` — the OAuth **Device Flow** (RFC 8628) request/response shapes
  and the pure decision function (`interpret_token_response`) that turns one
  poll response into `Approved` / `Pending` / `SlowDown` / `Denied` /
  `Expired` / `Failed`. Device flow was chosen over a loopback-server
  authorization-code flow because it needs nothing for Relay to host: no
  redirect URI, no port to bind, no browser-launched callback to catch — the
  user types a code into a page GitHub serves, and the app only ever polls
  for the outcome. The trade-off (typing a code instead of one browser click)
  is paid once per login, not per session. The OAuth App client id is not
  baked into the binary: device flow has no client secret to protect, so the
  id is exactly as sensitive as a URL, and it lives in `GithubConnectorSettings`
  (`settings.json`, key `github.settings`) alongside the polling rules — set
  once from the connector's "Connect GitHub" screen, which links out to
  GitHub's OAuth App settings. `connect_start` fails fast, before any network
  call, if none is configured (`rules::effective_client_id`), rather than
  sending an empty or placeholder id to GitHub and surfacing whatever cryptic
  error comes back (a 404, in practice — GitHub treats an unrecognized client
  id as a missing resource, not an auth error).
- `client.rs` — the `GitHubClient` trait (device-flow endpoints, search,
  pull request detail, check runs) plus `HttpGitHubClient`, its `reqwest`
  implementation. Every poll-loop and device-flow function is generic over
  this trait, exactly the way `jobs::spawn` is generic over `EventSink`, so
  `FakeGitHubClient` (canned, ownership-consumed responses) exercises the
  whole pipeline in `cargo test` with no network and no live GitHub.
- `token_store.rs` — where the access/refresh token lives at rest. This is
  the one place the connector deliberately does **not** follow `vault.rs`'s
  pattern: a password-derived key would gate every read behind a master
  password prompt, which a background poll job running with no window open
  cannot supply. Instead the token goes into the OS's own secret store
  (Keychain / Credential Manager / Secret Service) through the `keyring`
  crate — the same place a browser or a git credential helper keeps a saved
  login, already access-controlled per-OS-user without Relay reimplementing
  that. `TokenStore` is a trait for the same reason `EventSink` is: tests run
  against an in-memory fake rather than a real keychain.
- `rules.rs` — `GithubConnectorSettings`: a poll interval, `NotificationSettings`
  (one `NotificationTypeRule` per `PrEventKind` — an on/off switch plus a
  `*`-glob repo pattern and optional branch include/exclude globs), and a
  flat `muted` list of exact exceptions (`"owner/repo"`, `"owner/repo@branch"`,
  or `"owner/repo#123"`, checked before any rule). `NotificationSettings` is
  named fields rather than a list of freeform rules or a map keyed by kind —
  there are exactly six kinds, so `rule_for(kind)` is a `match`, and the
  settings UI can show one row per kind without an "add rule" step. This is
  not secret, so unlike the token it lives in the same `settings.json` every
  other preference does, under the key `github.settings` — the frontend
  settings page and the Rust poll loop both read it through
  `tauri-plugin-store`, so there is one copy instead of two that can drift.
  The default settings notify on opened, merged, review-requested and a
  failed build, but not a passing one or a plain close — the one status that
  mostly confirms nothing is wrong, which gets noisy fast if it fires on
  every PR you touch.
- `poll.rs` — the recurring job. Each cycle runs one GitHub Search API query
  (`is:pr involves:<username>`, the broadest reading of "the signed-in user's
  PRs" that still fits one call) sent with the previous cycle's ETag; a 304
  costs nothing against the rate limit and skips the rest of the cycle
  entirely. For anything the search returns, it fetches the pull request and
  its check runs, diffs the result against an on-disk cache
  (`github-poll-cache.json`, plain JSON — nothing in it is secret) keyed by
  `"owner/repo#number"`, and for every real change it spawns a short-lived
  job via `jobs::spawn` that reports one `AppEvent::Notification` and
  finishes — the same job/event pipeline any other producer uses, one
  ephemeral job per notification rather than the long-running poll job
  reporting through its own id. `MIN_POLL_INTERVAL_SECS` (60s) is enforced
  regardless of what settings.json says, since GitHub's Search API allows 30
  authenticated requests/minute and one cycle costs one search call plus one
  pair of calls per changed PR.

Known simplifications, acceptable at personal-PR-list scale: CI state comes
from the Checks API only (GitHub Actions and anything else reporting check
runs), not the older separate Statuses API; the search query is not
paginated, so an account with more than 100 relevant open items at once
would not see all of them; and the on-disk PR cache means a very old,
low-activity PR could in principle scroll off the search API's relevance
ranking and later reappear as a fresh "opened" notification.

Connecting is a command (`github_connect_start`) that makes one blocking
call (`tauri::async_runtime::block_on`, the same tool `jobs` reaches for
when sync code needs one async result — see the note on why commands stay
synchronous, above) to fetch the device code, then hands the wait for the
user's approval to a background job and returns immediately with the code to
display. That job reports `Waiting` while it polls, and on success stores
the token and starts the recurring poll job itself — `github::GithubState`
only ever tracks that one job's id, so `github_disconnect` can cancel it and
clear the keychain entry. Resuming polling after a restart is one call in
`lib.rs`'s `setup()`: if a token is already in the keychain, start the poll
job without asking the user to reconnect.

Every failure path in that job — denied, expired, a malformed response, a
network error, a keychain write that fails — is funneled through one
`ctx.report(Blocked, error.to_string(), ...)` before the job returns the
error (`run_device_flow`'s inner function does the actual work; the outer
one exists only to wrap it in that single report point). The alternative —
reporting only the handful of outcomes the function itself distinguishes by
name — silently swallowed anything else into a bare
`NotificationDone { ok: false }` with no way to say why, which is exactly
what made an early version of this feature look like clicking "Connect" did
nothing at all.

The frontend surface is `src/app/features/github/github.ts`, rendered inside
a "GitHub" tab on the Settings page (`src/app/features/settings/settings.ts`)
rather than as its own top-level view. `CoreCommand::OpenGithub` still shows
the main window and emits `AppEvent::OpenGithubRequested`, exactly as
`OpenVaultRequested` does for the vault; `Home` now treats it as "open
Settings, and select the GitHub tab" rather than switching to a dedicated
view. Settings hides its inactive tab's content with `[hidden]` rather than
an `@if` — an `@if` would destroy and recreate the GitHub tab's component on
every switch away from it, and a Device Flow wait (anywhere from a few
seconds to a couple of minutes, how ever long the user takes to approve it
on GitHub) needs its listener to survive being backgrounded like that.

## Gmail connector

`src-tauri/src/gmail/` is Relay's other external service connector,
alongside GitHub (above). It is a directory module rather than one file, the
way `jobs/` is, because it has four fairly separate jobs of its own:

- `oauth.rs` — the Google OAuth "installed application" handshake: PKCE
  (RFC 7636), a one-shot HTTP listener on an OS-assigned loopback port, and a
  `state` parameter checked for CSRF. There is no way to embed a client
  secret confidentially in a distributed desktop binary, so the client id is
  treated as public and PKCE carries the actual proof that whoever completes
  the token exchange is the same process that started it — Google's
  documented flow for desktop apps, and the reason a "Desktop app" OAuth
  client accepts a loopback redirect at any port without pre-registering it.
  The client id/secret for Relay's own Google Cloud project are committed in
  `src-tauri/gmail.config.toml` and compiled in via `include_str!` —
  deliberately, not an oversight: per the paragraph above, this OAuth client
  type does not treat the secret as confidential in the first place, so
  shipping it the way any other installed application ships its client id
  costs nothing a distributed binary would not already expose. `RELAY_GMAIL_CLIENT_ID`
  / `RELAY_GMAIL_CLIENT_SECRET` env vars override the compiled-in pair when
  set, for developing against a different Google Cloud project without
  editing the tracked file.
- `api.rs` — the Gmail/OAuth HTTP surface behind a `GoogleApi` trait, real
  (`HttpGoogleApi`, `reqwest`) and fake implementations, the same seam
  `jobs.rs` uses `EventSink`/`FakeSink` for. The connector requests
  `gmail.metadata` — not the broader `gmail.readonly` — which is enough to
  read headers and labels for every method it calls (including
  `history.list`) while making a message body or attachment impossible to
  fetch even by a bug: the least-privilege scope that can still show a real
  sender and subject.
- `poll.rs` — turns a stored `historyId` plus one `history.list` call into
  the small list of messages worth notifying about. The first poll after
  connecting has no `historyId` yet, so it only establishes a baseline
  (`users.getProfile`) and notifies about nothing; every poll after that
  walks forward from the last checkpoint, so a poll costs what changed, not
  a full mailbox scan, and stays comfortably under Gmail's per-second quota
  even at the connector's default 60-second interval. A `historyId` that has
  aged out of Gmail's retention window (a 404) re-baselines the same way a
  fresh connection does, rather than guessing at what was missed.
- `rules.rs` — pure, independently enable-able notification rules (Gmail's
  own `IMPORTANT` label by default, plus optional "notify on everything" and
  sender/subject/label rules), deliberately flatter than a per-repo rule
  matrix would be: Gmail has no directory structure to match against.

The polling job itself is one of `jobs::spawn`'s first real callers: a loop
that checkpoints, polls, reports each match as `AppEvent::Notification`
(sender in the title, subject in the detail, never a body), sleeps, and
repeats — cancelled the same cooperative way any other job is, on
disconnect.

**Token storage** follows vault.rs's AES-256-GCM construction but not its key
derivation. A background mail poller cannot prompt for a master password on
every launch — that would defeat the point of running unattended — so
`secret.rs` generates a random 32-byte key once and hands it to the OS's own
secret store (Keychain, Credential Manager, or Secret Service/libsecret, via
the `keyring` crate) instead of deriving it from something the user types.
Only that key touches the keychain; the refresh token itself stays out of
plaintext in `gmail.json`, encrypted next to the rest of the connector's
settings. `KeyStore` is a trait for the same reason `EventSink` is: most test
environments have no keychain daemon at all, so the test suite runs against
an in-memory `FakeKeyStore`.

The frontend surface, `src/app/features/gmail/gmail.ts`, is a "Gmail" tab on
the Settings page (`<rl-gmail />`) alongside GitHub's, rather than a
top-level view of its own — unlike the vault, there is no separate workspace
here, just a panel of connector settings, so it needs neither a palette
command nor a `CoreCommand`/`AppEvent` pair to switch `Home` to it; a user
already on the Settings page reaches it by clicking the tab.

## Not built yet

Project and task models, agent orchestration, and the context layer that
lets commands know what you are working on.
