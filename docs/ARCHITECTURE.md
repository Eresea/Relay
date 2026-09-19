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
honoured identically across platforms (the GTK build maps the HUD at startup
anyway), which is why `setup` now hides it explicitly rather than trusting
the window config to give every platform the same starting state.

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

`src-tauri/src/jobs/scan.rs` is the first real producer: it walks the user's
home directory with `tokio::fs`, counting files and folders and reporting
progress every 200 entries, wired to the "Scan home folder" palette command
(`CoreCommand::ScanHome`). It is deliberately simple — a count, not an index —
because its job is exercising checkpointing and progress reporting against
real, unpredictable I/O, not building the eventual project-scan feature.

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

## Not built yet

Project and task models, agent orchestration, external service connectors,
settings persistence beyond the store plugin, and the context layer that lets
commands know what you are working on. The events/jobs pipeline above is
built and wired end to end, with a home-directory scan as its first real
producer — an agent run and a file watcher still need to be written.
