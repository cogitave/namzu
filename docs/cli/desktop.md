---
type: Guide
title: Desktop application
description: Local native operator preview, its shared CLI runtime, folder trust, conversations, model choices, approvals and background work.
resource: packages/desktop
tags: [cli, desktop, sessions, permissions]
---

# Desktop application

The private `@namzu/desktop` application is a native operator preview. It uses
`namzu acp --desktop` as a child process per canonical project. The CLI composes
providers, tools, MCP servers, plugins, policy and the kernel; the app does not
import CLI code or create a second agent execution loop.

## Run from source

Install and build the workspace, then launch with the checkout's built CLI:

```sh
NAMZU_DESKTOP_CLI="$PWD/packages/cli/dist/bin.js" pnpm --filter @namzu/desktop start
```

Without `NAMZU_DESKTOP_CLI`, the app runs the installed `namzu` command. It checks
for desktop host support at initialization and reports an incompatible CLI.
`NAMZU_DESKTOP_CLI` is a main-process executable entry setting, never a renderer
argument or model input. On Windows the installed `.cmd` shim is invoked through
a fixed `namzu acp --desktop` command; project paths are passed as process cwd.
The app is not yet distributed through native installers or auto-update.

## Appearance and message display

The app opens in its dark appearance. The sidebar appearance control cycles
through light, system and dark; the local choice survives window reload. The
two-row wordmark and phosphor-green accents match the operator CLI. Menu,
panel and message transitions respect the system reduced-motion preference.
Projects group their conversations in the sidebar. Search filters the loaded
conversation titles. The model control is one menu inside the composer; the
provider and exact model choice are edited there before the next message.

Assistant replies render headings, lists, fenced code and tables. User messages
stay literal. Raw HTML cannot execute, remote images do not load and message
links are currently displayed as text. Tool output remains a separate tool view.
Background work uses a separate column in a wide window and an overlay in a
narrow window. The composer and navigation remain inside the available width.

## Operator flow

Open a folder. If it is not already trusted by Namzu, the app shows its exact
canonical path and a native confirmation before allowing project access. A new
protocol session alone never grants trust. Cancel keeps the folder untrusted.

Choose a saved conversation or start a new one. Saved history comes from Namzu's
existing scoped logs and index; archived conversations cannot be resumed as
writers. The app stores project paths in its own preferences, not conversation
records or provider secrets. Historical display is a bounded text
projection of the latest 200 messages/200,000 characters and marks a partial view.
The kernel loads the full admitted history for the model independently.

Provider and model choices use existing CLI credential discovery. Set up missing
credentials in Namzu. The desktop receives provider IDs, labels and default
model names, never keys or token objects. Sending an idle turn applies the shown
choice before submitting the prompt. Failed selection is visible and prevents
sending on an unintended route. A model change cannot silently kill active work.
Choices last for this connection and survive window reload, rather than editing
global CLI preferences. Existing fallback and delegation preferences remain in
force. Reload also restores live messages, pending reviews and queued prompts
from the main process; it does not restart the running turn.

Tools stream their registry-owned presentations. Allow once or decline the exact
pending batch. Cancellation aborts its permission wait. Approval IDs belong to
the conversation that asked; navigation does not redirect an answer to another
conversation. Background work shows session-owned shells, retained output and a
stop action. It does not list or stop another session's jobs.

Enter sends; Shift+Enter adds a line. IME composition does not submit. While a
turn runs, new messages are queued for its next turn; they are visibly separate
from started prompts. Stop preserves queued text. Edit latest (Alt+Up) returns
an authored queued prompt to the composer. Drafts and queues are currently
connection-local. Closing the app waits for the runtime processes it owns to stop. A failed
connection offers Reconnect; stopped work is never silently replayed.

## Optional operator wire methods

These methods exist only under `--desktop`, and initialization advertises them.
Extensions are scoped to the child process's canonical project. They are not core
ACP methods and are not automatically installed in embedded SDK servers.

| Method | Arguments | Result |
| --- | --- | --- |
| `namzu/project/status` | none | canonical cwd and remembered trust |
| `namzu/project/trust` | exact `cwd`, `confirmed: true` | updated trust; client must require an operator confirmation |
| `namzu/conversations/list` | none | up to 100 recent project conversations |
| `namzu/conversations/history` | `sessionId` | bounded text messages and `partial` |
| `namzu/providers/status` | optional `sessionId` | safe configured provider metadata and saved default |
| `namzu/providers/select` | `sessionId`, `provider`, optional `model` | acknowledges a session-local choice; active work blocks changes |
| `namzu/jobs/list` | `sessionId` | this session's jobs |
| `namzu/jobs/read` | `sessionId`, `jobId` | retained chunk, offsets and dropped-byte count |
| `namzu/jobs/stop` | `sessionId`, `jobId` | stopped job |

The native main process owns these methods. Its preload exposes only named UI
actions, and checks the requesting window and main-frame URL. Node integration
is disabled, context isolation and renderer sandboxing are enabled, navigation
and additional windows/webviews are blocked, and the built UI has a restrictive
content policy. Model and tool text is rendered as text, never executable HTML.

## Current scope

The first slice covers local projects, conversation history, formatted replies,
tool review, reasoning, message queues and background shells. Attachments,
embedded browsing, terminal emulation, remote hosts, native release packaging and auto-update are not offered in this preview. Source comparisons
and validation receipts are in `research/runtime-desktop-20260930/`.
