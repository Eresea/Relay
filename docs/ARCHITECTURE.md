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
  merges at startup. These run over IPC.

The palette knows nothing about where a command came from. Adding a feature
means registering commands, not touching the palette.

Ranking is a small subsequence matcher in `core/fuzzy.ts` that favours word
starts and consecutive runs. A palette over a few hundred commands does not
need a real fuzzy-finder, and a scoring function you can read is worth more
than one that ranks marginally better.

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

Project and task models, agent orchestration, the notification stream feeding
the HUD, external service connectors, settings persistence beyond the store
plugin, and the context layer that lets commands know what you are working on.
