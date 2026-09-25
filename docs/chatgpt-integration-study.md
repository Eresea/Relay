# Relay → ChatGPT/Codex integration

**Date:** 2026-09-25
**Scope:** Relay-initiated local Codex work, desktop handoff, and the current remote/mobile boundary.

## Finding

Relay now starts or resumes local Codex threads, sends prompts, and returns the completed response through the official Codex App Server over stdio. This uses the same local Codex installation and sign-in as the desktop app, without embedding a Node runtime in Relay. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

This is Codex integration only. The SDK and App Server do not document selecting and sending into an existing general Chat or Work conversation. A Relay-created thread can be opened using the documented desktop deep link, but shared history visibility still needs an end-to-end check. [Desktop deep links](https://learn.chatgpt.com/docs/reference/commands)

No documented ChatGPT mobile app API for receiving or continuing a Codex thread was found. Relay mobile can only show a result from Relay's own remote runner, which is not a ChatGPT mobile conversation.

## SDK and App Server

The TypeScript package `@openai/codex-sdk` requires Node.js and supports starting, continuing, and resuming local Codex threads. The documented API uses `new Codex()`, `startThread()`, `thread.run(prompt)`, and `resumeThread(threadId).run(prompt)`, returning `finalResponse`. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

Relay uses the lower-level App Server because it is a Rust/Tauri app and does not bundle Node as an application runtime. App Server provides local stdio JSON-RPC, thread start/resume, turns, and completion events. Its remote WebSocket listener is experimental and explicitly unsupported for production workloads. [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## What Relay does

- The desktop Codex page lists local threads newest by recent activity, pages through older threads, opens a thread with its full turn and item history, and can hand it off to Codex desktop. New work can start a thread or resume the selected thread.
- Thread history comes from App Server `thread/list` and `thread/read`; when the server returns paginated history, Relay reads every turn page in full before displaying it. User and agent Markdown is sanitized before rendering; tool calls, command output, file changes, and other stored items remain available in expandable detail blocks.
- Relay launches a local `codex app-server --stdio` process per send, so Codex CLI must be installed and signed in on the same machine.
- Turns can read and write within the selected workspace plus platform defaults, with network access disabled. Relay sets `approvalPolicy: "never"`; pressing Send therefore authorizes Codex to run commands and edit files inside that workspace without further approval. Requests for extra access are declined; the UI states this before the send action.
- The App Server thread ID can be passed to the documented `codex://threads/<thread-id>` desktop deep link. Whether an App Server-created thread always opens with shared history in the desktop UI still needs a real end-to-end check.

## Remote and mobile

- **Remote desktop:** Not implemented. A remote runner or supported transport is required. OpenAI currently marks App Server's WebSocket transport experimental and unsupported for production, so Relay does not expose it.
- **Mobile:** No documented ChatGPT mobile API for sending prompts or resuming Codex threads. A remote Codex runner could return results to Relay mobile, but that uses Relay's UI and requires a separate authenticated service.
- **Chat and Work:** No documented desktop API for sending into existing general Chat or Work conversations was found. This implementation targets Codex threads only.

## Remaining proof

Run a signed-in local end-to-end check: create a thread from Relay, send a prompt, resume it with a second prompt, and verify `codex://threads/<thread-id>` opens that same history in the Codex desktop app. No model request or desktop handoff was run during implementation.
