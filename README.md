# Relay

A lightweight desktop control layer for Windows and Linux. Relay unifies
projects, tasks, agents, notifications and system actions behind one global
command interface, and otherwise stays out of the way.

It is not a dashboard. There is no home screen to check. A global shortcut
opens a command palette; ambient overlays surface progress and alerts when
something needs to be known, and disappear when it does not.

**Status: scaffold.** The shell runs — global shortcut, tray, palette, theming,
the Umbra token layer — and the orchestration behind it is not built yet.

## Principles

- **Low overhead.** Launching Relay costs nothing visible. The main window
  stays hidden until asked for.
- **Strong context.** Commands know what you are working on.
- **Minimal interruption.** Overlays report; they do not demand.
- **Keyboard first.** Every action is reachable from the palette. The mouse is
  optional throughout.
- **Progressive disclosure.** Depth is available on request, never on display.

## Requirements

|         |                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node    | 22 or newer                                                                                                                                      |
| Rust    | stable, 1.82 or newer                                                                                                                            |
| Linux   | `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `build-essential`, `curl`, `wget`, `file`, `libssl-dev` |
| Windows | [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Windows 11) and the MSVC build tools                       |

Install Rust from [rustup.rs](https://rustup.rs). Nothing else is needed on
Windows beyond the Visual Studio build tools that rustup offers to install.

## Getting started

```bash
npm install
npm run dev          # Tauri dev build: Rust core + Angular dev server
```

`npm run dev` starts the Angular dev server on port 1420 and launches the
desktop shell against it. The main window is hidden by default — press
**Ctrl+Space** for the palette, or use the tray icon.

To work on the interface alone in a browser, `npm start` and open
`localhost:1420/?surface=palette`. Calls into the Rust core become logged
no-ops, so every screen still renders.

## Commands

```bash
npm run dev          # run the desktop app against the dev server
npm run app:build    # produce installers (NSIS, deb, AppImage)
npm run build        # frontend only
npm test             # frontend unit tests (Vitest)
npm run lint         # ESLint over TypeScript and templates
npm run format       # Prettier
npm run rust:lint    # clippy, warnings denied
npm run rust:test    # cargo test
```

## Layout

```
src/                  Angular frontend
  app/core/           command registry, IPC bridge, theme, entity hues
  app/features/       palette, HUD, main window
  app/shared/         Icon, Kbd
  styles/tokens/      the Umbra token layer — mirrors Umbra's own file names
  assets/             vendored Geist fonts and Lucide glyphs
src-tauri/            Rust core
  src/overlay.rs      show/hide behaviour for the floating windows
  src/commands.rs     the entire IPC surface
  src/shortcuts.rs    the global accelerator
  src/tray.rs         tray icon and menu
docs/                 architecture and design notes
```

## Design

Relay is built on **Umbra**, a design system for minimal desktop applications.
The token layer under `src/styles/tokens/` mirrors Umbra's own file structure
so updates can be dropped in file for file. See [docs/DESIGN.md](docs/DESIGN.md)
for what is bound, what was substituted, and the rules that matter most.

The app icon is a placeholder — a neutral tile with an `R`. Umbra deliberately
ships no logo. Supply a real mark and regenerate with
`npx tauri icon path/to/mark.png`.

## Licence

MIT. See [LICENSE](LICENSE).
