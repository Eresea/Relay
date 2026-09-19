# Contributing

## Setup

```bash
npm install
npm run dev
```

Rust stable and Node 22 are required; see the README for platform packages.

## Before opening a pull request

```bash
npm run lint && npm test && npm run format:check
npm run rust:lint && npm run rust:test
```

CI runs the same set on Windows and Linux.

## Conventions

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org):
`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`. The scope is the area —
`feat(palette):`, `fix(tray):`.

**Angular.** Standalone components, `OnPush`, signals for state. The app is
zoneless; do not add `zone.js`. Selectors are prefixed `rl-`.

**Rust.** `cargo fmt` before committing. Clippy warnings are errors. Anything
that can fail across IPC returns `Result` from `src-tauri/src/error.rs`.

**The IPC surface is a boundary, not a convenience.** New commands go in
`src-tauri/src/commands.rs` and are called through `src/app/core/tauri.ts`.
Do not call `invoke` from a component.

**Design.** Read [docs/DESIGN.md](docs/DESIGN.md) before touching anything
visual. Use the tokens; do not hard-code a colour, a radius or a dimension. The
four rules under "The rules that bite" are the ones reviewers will check.

**Accessibility is not a later pass.** Real `<button>`, `<a href>` and
`<input>` + `<label>`, never `role` on a div. Icon-only controls carry
`aria-label`. Focus must be visible on every interactive element.
