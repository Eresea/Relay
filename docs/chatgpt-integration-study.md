# Relay → ChatGPT/Codex integration study

**Date:** 2026-09-25
**Scope:** How Relay can initiate and continue Codex work, reach the desktop app, and what is documented for mobile; no integration code is implemented.

## Finding

Yes: Relay can programmatically create, continue, and resume **local Codex threads**, send prompts, and receive results through the official Codex SDK. This is the strongest fit for event-driven Relay actions and matches the user's example in its core flow. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

The important boundary is that the SDK controls Codex threads; it is not documented as an API for selecting and sending into an already-open ChatGPT Chat/Work conversation or as a guarantee that a thread created by Relay appears in the desktop app's history. That UI/history sharing should be a small proof, not an assumption. Separately, the ChatGPT desktop app supports a deep link that opens a new chat with the composer prefilled, but the user must press Send. [Desktop deep links](https://learn.chatgpt.com/docs/reference/commands)

I found no documented ChatGPT mobile app API for receiving or continuing these Codex SDK threads. A Relay mobile client could show a result from a remote Codex runner, but that would be Relay's UI, not the ChatGPT mobile app.

## Codex SDK: primary route

The TypeScript SDK package is `@openai/codex-sdk`, is server-side (Node.js 18+), and officially supports starting, continuing, and resuming local Codex threads. The documented pattern is `new Codex()`, `startThread()`, `thread.run(prompt)`, and `resumeThread(threadId).run(prompt)`, returning `finalResponse`. [Codex SDK usage](https://learn.chatgpt.com/docs/codex-sdk)

The user's example matches that documented lifecycle. The docs page's minimal example does not show its `workingDirectory` option; confirm that exact option against the installed SDK version before depending on it.

The SDK is aimed at automation and integrating Codex into an application. The related Codex App Server is the lower-level route for a custom client that needs authentication, history, approvals, and streamed events. It supports local stdio and Unix sockets; the WebSocket/remote listener is currently experimental and explicitly unsupported for production workloads. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## What “desktop app integration” means

There are two distinct user experiences:

| Route | Relay can do | What it does not establish |
| --- | --- | --- |
| Codex SDK | Start/resume a local Codex thread, submit work, and receive the final result in Relay. | It does not document targeting an existing ChatGPT Chat/Work composer or syncing visibility into the desktop UI. |
| Codex App Server | Build a richer Relay client around Codex auth, threads, approvals, and streamed events. | Remote WebSocket serving is experimental; this is Relay embedding Codex, not Relay automating the official ChatGPT window. |
| `codex://` deep link | Open the installed desktop app on this machine with a new chat and prefilled prompt, optionally with a local project path. | It does not send automatically, return a response to Relay, or address another machine. |

OpenAI documents `codex://threads/new`, `codex://new?prompt=<encoded>&path=<absolute-path>`, and `codex://threads/<thread-id>`. The prompt remains in the composer until the user sends it. Relay already has Tauri's opener plugin and `TauriBridge.openUrl` (`src-tauri/Cargo.toml:20`, `src-tauri/src/lib.rs:61`, `src/app/core/tauri.ts:159-163`). [Deep-link reference](https://learn.chatgpt.com/docs/reference/commands)

## Local, remote, and mobile

- **Local desktop Relay:** The SDK can run Codex locally and return the response into Relay. Test whether its thread can be opened in the installed ChatGPT desktop app with `codex://threads/<thread-id>` and whether both clients see the same history. OpenAI documents both local SDK threads and desktop deep links, but not that they interoperate.
- **Remote Relay:** The SDK documentation describes local threads. For remote execution, Relay would need a Codex runner on the target machine or a remote service that owns the SDK process and thread IDs. App Server has a WebSocket listener and remote-client guidance, but OpenAI marks that transport experimental/unsupported for production; do not expose it publicly without a separately designed authenticated boundary.
- **Mobile:** No official mobile ChatGPT app API for sending a prompt to or resuming a Codex thread was found. The SDK can still run remotely and return its result to a Relay mobile client, but that is not a ChatGPT mobile conversation. Treat share/copy as a manual handoff only.

## Relay fit

- Relay is a Tauri desktop app with Angular UI and a Rust core. It already has local project discovery and can derive project context (`src-tauri/src/workspaces.rs:11-15,39-79`).
- The TypeScript SDK is server-side and requires Node. Relay's package has Node-based build tooling, but the packaged desktop application does not currently define a Node runtime/sidecar. An implementation needs to decide how Codex runs and how its authentication/sandbox lifecycle is managed; do not import the SDK into the Angular browser bundle.
- A Node sidecar using the official SDK most closely matches the documented automation flow. Direct Rust integration with App Server avoids introducing a Node runtime but depends on the lower-level protocol and its current maturity. A remote runner is another option when Relay needs mobile or cross-device access.
- Relay's Nexus OAuth/sync paths are separate from Codex authentication and do not authorize Codex or expose ChatGPT conversation history.
- Relay's broader project/task model, agent orchestration, and context layer are explicitly not built (`docs/ARCHITECTURE.md:375-379`).

## Recommended proof

Run a minimal local SDK spike from Relay's existing project path: start a thread, save its ID, run a prompt in that workspace, resume the same ID with a second prompt, and return both `finalResponse` values to Relay. Then open the thread ID through the desktop deep link and confirm whether the app displays the same thread. Keep file access and sandbox settings explicit.

That proves useful Relay → Codex communication without waiting for ChatGPT UI automation. If the requirement is specifically “the user sees the interaction in the official desktop app,” the UI/history-sharing check is a gating proof. If mobile or remote execution is required, decide whether Relay owns that UI through a remote Codex runner or whether an official, supported remote app-server transport becomes available.

## Limits

This is a current-docs and source-tree study, not a runtime verification of the SDK, app-server auth, desktop history sharing, remote execution, or mobile behavior. The docs establish SDK thread lifecycle and local execution; they do not establish that Relay can control arbitrary ChatGPT Chat/Work UI sessions.
