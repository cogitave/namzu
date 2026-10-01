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
The sidebar header has a fading phosphor blueprint surface. Collapse it using
the header control or Ctrl/Cmd+B; the desktop preference survives reload.
On narrow windows the same control opens the navigation drawer.
Project cards show conversation title, last activity and execution/review state.
The blank conversation centres its composer; the first message docks it with a
short transition. The composer keeps its project context in a lower strip.
In an existing conversation, an unfocused single-line composer rests at 32px;
focusing it or writing multiple lines expands the input. Its model control moves
into the context strip while resting. Height motion moves the actual dock and
reserved transcript space together rather than covering messages with a moving
decoration.
The sidebar lists conversation cards with their project on each card. Its project
menu selects a folder and filters the list. Search filters loaded conversation titles. The model control is one menu inside the composer; the
provider and exact model choice are edited there before the next message.

Assistant replies render headings, lists, fenced code and tables. User messages
stay literal. Raw HTML cannot execute, remote images do not load and message
links are currently displayed as text. Tool output remains a separate tool view.
Messages and tool rows retain their admitted event order. Repeated provider call
IDs in later turns have separate receipts; progress updates do not move a row.
Interface and composer text use the platform sans stack; code uses the platform
monospace stack. The interface root is 16px, conversation/composer text is 14px
and fenced code/diff text is 13px. The application uses the platform's font face,
so the same stack can resolve to different faces on different operating systems.
The project and conversation breadcrumb uses 14px medium labels with native
text-box trimming where supported; narrow windows retain the conversation title.
Completed file actions expose their bounded before/after previews in Changes.
Open diff opens the same previews; unified/split display and line wrapping work
without reading additional files. Line numbers refer to the preview, which may
contain only the changed fragment. These result views survive a window reload
while the connection lives; the current restart history projection contains text
messages rather than old tool previews. Syntax highlighting uses bundled WASM;
the renderer policy allows that compilation without enabling JavaScript eval.
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
pending batch in the attached composer approval strip. A compact summary and
batch count remain visible; Review action details exposes every exact input and
destructive marker. Follow-up drafting and queuing remain available while a
review waits. Cancellation aborts its permission wait. Approval IDs belong to
the conversation that asked; navigation does not redirect an answer to another
conversation. Background work shows session-owned shells, retained output and a
stop action. It does not list or stop another session's jobs.

Enter sends; Shift+Enter adds a line. IME composition does not submit. While a
composition is active, global Escape and other shortcuts do not cancel work or
open another surface. While a
turn runs, new messages are queued for its next turn; they are visibly separate
from started prompts. Open the queued-message count to inspect every pending
message, edit one or remove that exact item. Stop preserves queued text. Edit
latest (Alt+Up) returns an authored queued prompt to the composer; a non-empty
draft must be sent or cleared first, so editing cannot discard unrelated text.
A message that has already started cannot be edited or removed from the queue.

Unsent drafts belong to their conversation in the main process. Reopening a
conversation after a window reload restores its acknowledged draft, even while
the runtime connection is unavailable. Each draft accepts at most 50,000
characters; the application retains at most 1,000,000 draft characters across
open conversations. A refused save remains visible as an error. Drafts are not
model messages and are not written to conversation history or disk. Drafts and
queues are connection-local and end when the application quits.

A draft-only conversation remains in the sidebar after reconnecting. Because
an unsubmitted conversation has no durable runtime history yet, the desktop
recreates its runtime slot while retaining the same conversation and draft
owner. Its first submitted message, review and answer stay in that conversation.

Rapid navigation keeps the most recently selected conversation in view. An
older history, model or output request cannot switch back to its former target
or show another conversation's background output. Reattaching a captured
history snapshot also retains newer live messages, queue changes and reviews;
already included chunks are not appended twice. Closing the app waits for the
runtime processes it owns to stop, including a connection already terminated
by a signal. A failed connection offers Reconnect; stopped work is never
silently replayed.

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
