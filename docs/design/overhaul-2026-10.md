# Relay 1.0 — design overhaul proposal

25 October 2026. Nine prototype screens under `docs/design/prototype/png/`,
sources under `prototype/src/`, re-rendered with `prototype/render.ps1`
(headless Edge, 2× scale). Nothing here is wired to the app.

## The idea in one paragraph

Relay stops being "a launcher with some screens" and becomes an operating
layer with four surfaces and one contract. The four surfaces are the
**Omnibar** (Ctrl+Space, replaces the palette), the **Attention** pill and
stack (replaces the HUD), the **Deck** (the one main window) and the
**Phone**. The one contract is the **module**: everything Relay can do —
Mail, Files, Flow, Codex, Vault, Linear, GitHub, a pinned web app, an MCP
server — declares the same four things: commands (for the Omnibar), items
(for Today and search), surfaces (tabs and panes in the Deck) and signals
(for the pill and the stack). Relay draws all of it; a module never paints its
own chrome. That is how it hosts anything without becoming heavy: a module
that is off costs nothing, and a module that is on only ever adds rows,
tiles and panes to a shell that already exists.

## Screens

| #   | File                | What it shows                                                                                                                                                                                                                                |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | `01-omnibar.png`    | Ctrl+Space over the desktop. Context chips (project, branch, running agents), four modes (Do / Ask / Find / Run), grouped results from every module, a preview pane that states cost and reversibility before Enter.                         |
| 02  | `02-attention.png`  | The glass tier at rest and expanded. A one-line pill at the top of the screen; Ctrl+. opens the stack: running jobs with progress, one card that needs you with its cost named, quiet items collapsed into one row.                          |
| 03  | `03-deck-today.png` | The Deck with **Today**: a triage list that merges agents, PRs, mail and issues under Needs you / Happening / Quiet, a detail pane for the selection, an inspector with agenda, working set and devices.                                     |
| 04  | `04-workbench.png`  | Split panes: a Codex thread with plan, live diff and a permission line, beside **Flow** (Logos' terminal) with blocks, inline explanation of a failure, and a running build. The inspector shows changes, permissions and cost for the task. |
| 05  | `05-files.png`      | One tree over every place a file can live: this PC, OpenCloud, GitHub, Vault, Leaf, the phone, mail attachments. "Where else" column; inspector with actions and people, including an agent as a reader.                                     |
| 06  | `06-modules.png`    | The module registry. Each card says what the module gives and needs, its idle footprint, and whether agents may drive it. Add from: Relay module, MCP server, web app, CLI.                                                                  |
| 07  | `07-mobile.png`     | The phone is Today plus the Omnibar as a sheet. Approvals raised by desktop agents are answered here. Commands are scoped to a device.                                                                                                       |
| 08  | `08-light.png`      | Screen 03 in light. Every token mirrors; nothing is restyled by hand.                                                                                                                                                                        |
| 09  | `09-system.png`     | Umbra 2: tonal ladder, ink steps, status vs module hue, type, spacing, controls, the two tiers and the rules.                                                                                                                                |

## What changes against today's design

Umbra stays the DNA. Three changes, each visible in the screens:

1. **A deeper tonal ladder (bg-0 … bg-4).** Panes separate by tone, not by
   hairline. Today's single `--bg-app` / `--surface-card` pair is why every
   boundary needs a border and why the main window reads flat and busy.
2. **Module hue as a first-class token.** Today's seven entity hues keep
   their rule (which, never how) and extend to modules. A third-party module
   gets a hue by stable hash, same as an agent does now.
3. **Two tiers, never mixed, now with a pill.** Glass stays reserved for the
   desktop tier. The HUD becomes a pill plus a stack because a single 420×160
   card cannot show three jobs and one question without demanding attention
   for all four. The pill is the fix for "the overlay is not practical yet"
   in the status report: it is always one line, and it never asks.

Everything else is Umbra as written: Geist, sentence case, mono numerals,
no cursor change, say what it costs, buttons name the action.

## The module contract

A manifest, declared up front, approved once:

```
module:      id, name, hue (optional), version, source
gives:       commands[], items (kinds, search), surfaces[], signals[]
needs:       shell | files(scope) | network(hosts) | mail | calendar | vault | agents-may-drive
surface kind: native (Rust view-model → shell renders)
              web    (isolated webview, postMessage bridge, any framework)
              mcp    (tools → commands, resources → items, no UI)
              cli    (Flow runs it, the stack reports it)
```

Agents are tenants of the same contract: a Codex task is a module instance
with its own permissions, shown on every surface it appears on (thread
header, Today row, attention card, Files "people").

## Tech stack

**Tauri 2 stays.** The split in `ARCHITECTURE.md` is exactly the split a
module host needs: the Rust core owns module registry, permissions, jobs,
signals and every webview's lifecycle; the interface owns pixels. Two
Tauri-specific points matter for the Deck:

- Pinned web apps and web-kind modules want their own webview, not an
  iframe, for isolation and session separation. Tauri 2 can place several
  webviews in one window (behind the `unstable` feature today). Each costs
  real memory on WebView2, so create on open, destroy on close, keep state in
  the core. The Modules screen shows this as the "Idle 0 MB" line on purpose.
- Flow should render through its own component (xterm.js or Logos' own
  renderer) inside a shell pane. The host framework never touches terminal
  cells.

**Angular is the real question, and it is a cost question, not a capability
one.** Zoneless Angular with signals is technically sound and already in
place. What it costs is: a high bundle floor (841 kB initial against a 500 kB
budget, before any of these screens), a design-component ecosystem that is
second-class (shadcn is React; the Angular ports lag), and slower iteration
with AI tooling, which is fluent in React and Tailwind and markedly less so
in Angular templates. Umbra's Angular components are also the only part of
Umbra that is not framework-neutral.

Options, honestly weighed:

| Option                                            | Fit                                                                                                    | Cost                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep Angular 22, port only tokens                 | Lowest migration cost                                                                                  | Keeps every cost above; shadcn stays out of reach                                                                                                          |
| **React + Vite + Tailwind 4 + shadcn/ui (Radix)** | Best component and agent-UI ecosystem, best AI fluency, Umbra 2 becomes copy-in components like shadcn | Full UI rewrite (~43 TS files plus Umbra components); needs discipline to stay idle-cheap (signal-style stores, React Compiler)                            |
| Svelte 5 + shadcn-svelte (bits-ui)                | Signals-native, small runtime, the best-maintained non-React shadcn                                    | Smaller ecosystem; fewer people and models know runes                                                                                                      |
| Solid + shadcn-solid (Kobalte)                    | Closest to today's signal model, tiny bundles                                                          | Thinnest ecosystem of the three; ports lag                                                                                                                 |
| htmx                                              | —                                                                                                      | Wrong tool. It is for server-rendered hypermedia; Relay's UI is local-first, stream-driven (terminals, agent output, progress) with no HTTP hop. Rejected. |
| Rust UI (Dioxus 0.7, gpui, iced)                  | One language, no JS                                                                                    | Design ecosystem is thin and this proposal is design-heavy. Revisit for the pill and stack only, where a tiny native overlay would beat a webview.         |

**Recommendation.** Since this proposal rewrites every screen anyway, move
the interface to React + Vite + Tailwind 4 + shadcn/ui, keep Umbra as a
framework-neutral token layer (Tailwind's theme reads the same CSS
variables), and rebuild Umbra 2 components the shadcn way: copied into the
repo, not imported from a subtree. The module contract contains the lock-in:
web-kind modules can be written in anything, so the host framework is a
choice about Relay's own chrome, not about what Relay can host. If a rewrite
is not on the table this quarter, keep Angular and ship the tokens and the
pill first; nothing in the screens depends on the framework.

## Order of work

1. **Tokens.** Umbra 2 tonal ladder, module hue, glass tier. One file.
2. **Pill and stack.** Smallest surface, highest leverage, fixes the known
   overlay complaint. Needs a `signals` channel that already exists as
   `AppEvent::Notification`.
3. **Omnibar.** Modes, context chips, preview pane with cost. The command
   registry already carries most of the data.
4. **Deck shell with Today.** Rail, tabs, inspector, status bar. Today is the
   first module-agnostic surface; it is what makes the rail optional.
5. **Module registry.** Manifest, permissions, the Modules screen. Move Mail,
   GitHub, Linear, Vault behind it one at a time.
6. **Flow and agents as modules.** Workbench split panes land here.
7. **Phone.** Today plus the sheet; approvals routed through Nexus.

Also queued (26 Oct 2026):

- **Claude Code integration.** An agent alongside Codex; natural home is
  step 6, agents as modules.
- **Passkey auth for the Vault.** Unlock with a platform passkey.
- **Ergonomics.** Browser and IDE habits everywhere. Middle click, Ctrl+W
  and Ctrl+Tab on Deck tabs are done.
