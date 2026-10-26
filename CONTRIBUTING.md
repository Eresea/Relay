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

**React.** Function components, signals for state (`src/lib/signals.ts`):
call `useSignals()` once at the top of a component that reads them. Services
are classes reached with `inject()`; a screen's state is a class created with
`useController`. Controls come from `src/components/ui/`; style with Umbra
tokens through Tailwind's theme or a stylesheet scoped under the screen's root
class.

**Rust.** `cargo fmt` before committing. Clippy warnings are errors. Anything
that can fail across IPC returns `Result` from `src-tauri/src/error.rs`.

**The IPC surface is a boundary, not a convenience.** New commands go in
`src-tauri/src/commands.rs` and are called through `src/core/tauri.ts`.
Do not call `invoke` from a component.

**Design.** Read [docs/DESIGN.md](docs/DESIGN.md) before touching anything
visual. Use the tokens; do not hard-code a colour, a radius or a dimension. The
four rules under "The rules that bite" are the ones reviewers will check.

**Accessibility is not a later pass.** Real `<button>`, `<a href>` and
`<input>` + `<label>`, never `role` on a div. Icon-only controls carry
`aria-label`. Focus must be visible on every interactive element.
