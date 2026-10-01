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

### Live interface development

```sh
NAMZU_DESKTOP_CLI="$PWD/packages/cli/dist/bin.js" pnpm --filter @namzu/desktop dev
```

The development runner serves the renderer through a loopback Vite server,
watches the native TypeScript code and opens Electron against that server.
Renderer changes appear automatically without rebuilding the application.
CSS updates keep the current page; component updates may reload it. The native
host still owns conversations, admitted work and drafts during a renderer reload.

For a separately launched native window, `pnpm --filter @namzu/desktop dev:renderer`
starts the server and native compiler without launching Electron. Set
`NAMZU_DESKTOP_DEV_URL=http://127.0.0.1:5173/` in that window's host environment.
Only unpackaged development hosts admit an explicit HTTP loopback root URL.
Packaged applications load their bundled renderer; native IPC keeps its sender
and main-frame checks in either mode. The development CSP permits the local
reload connection; the bundled renderer retains its restrictive production CSP.

Open `http://127.0.0.1:5173/preview` in a browser to review the same interface with
clearly labelled sample projects and conversations. This development-only
preview keeps changes in memory and has no access to the CLI, credentials,
filesystem or live tasks. Use the native development window for actual work.

## Appearance and message display

The app opens in its dark appearance. The bottom Profile menu offers light,
system and dark appearance; the local choice survives window reload. The
two-row wordmark and phosphor-green accents match the operator CLI. Menu,
panel and message transitions respect the system reduced-motion preference.
The 32px integrated title bar keeps the operating system’s caption controls and
resize frame. Back and Forward revisit the window’s admitted project and
conversation views, with no prompt replay; the adjacent panel control toggles
the sidebar. File provides project and conversation actions; Edit, View and
Window open native menus. Native caption colours follow the chosen appearance.
The left icon rail remains available when the conversation sidebar is collapsed.
The rail contains Home, Spaces, Scheduled, Plugins and More, with Profile at
the bottom. Home owns the chat and blank composer; Spaces reveals the actual
project list. Plugins opens a separate Customize destination with the actual
installed inventory in its sidebar and a searchable card grid in the main area.
All, Project and Personal filter the inventory's real scopes; they do not claim
a public marketplace. The page shares its mutation and ownership guards with
the composer menu, including the restrictions on live changes. More offers
Open folder and Toggle sidebar. Profile holds local appearance settings and
does not claim a signed-in account. An update icon is absent until the host can
report an available update. Scheduled is currently unavailable in the desktop
preview; its disabled control never opens a conversation's background shells.
The sidebar brand opens its workspace menu. The labelled New conversation row is the primary
creation action, rather than duplicating it across icon groups.
The dark icon rail has a slightly deeper surface than the conversation sidebar.
That surface contrast separates navigation without a vertical divider.
The sidebar's corners facing the rail are rounded. When that sidebar closes,
the conversation canvas inherits the same top and bottom corners and clips its
content inside them; the Plugins destination follows the same layout. A smaller sidebar wordmark
sits over an ordered pixel accent that fades across the full sidebar header
width. The accent stays inside that header and does not receive pointer input.
The selected destination uses a filled icon and a neutral rounded background.
Hover, press and selection transitions are brief and respect reduced motion.
Navigation uses rounded stock outline icons and filled selected variants;
composer and result controls use licensed SVG assets. Known provider
routes show their service glyphs; other remote or local routes use cloud or
server symbols with the actual provider label.
Home opens the selected project’s blank composer, and the sidebar control or
Ctrl/Cmd+B toggles its list. On narrow windows the same control opens a drawer
below the title bar. Compact conversation rows appear underneath their owning
project groups. Group expansion is independent of project navigation, and opening a conversation
reveals its owning group. Folder glyphs follow the actual open/closed state with
a short crossfade and panel transition; reduced motion disables
those transitions. Running work, pending reviews and errors remain visible
in a reserved area on each conversation row.
The blank project or conversation centres its composer; the first message docks it with a
short transition. The composer keeps its project context in a lower strip.
The message box remains expanded, with model selection on the left and Send or
Stop on the right of its lower row. Send shows a busy indicator while the prompt
is being admitted. Model popups retain their mounted control while focus moves into
the menu. The project strip can open the native folder chooser. The first-message
transition moves the composer from the centre to the bottom and respects reduced
motion; merely focusing the editor does not change its layout.
A project context card sits beside the conversation when the workspace itself is
at least 1280px wide. Smaller workspaces expose it through the Project context
menu. It shows completed change receipts, verified background shells and current
activity, and opens the existing Changes or Background work detail pane. Pending
or failed shell reads remain unconfirmed rather than showing a stale count from
another conversation. Opening a detail pane returns the transcript to the
available width. Unsupported artifact and child-session inventories are absent.
The sidebar uses one folder glyph per project and plain indented conversation
titles. Each group initially shows five conversations, keeping the active one
visible when it lies beyond that limit. Show more reveals additional loaded
rows. Idle timestamps appear on hover or keyboard focus; running work, reviews
and errors remain visible.
Search sits at the right of the sidebar brand header. Clicking it or pressing
Ctrl/Cmd+K opens the same centred command
palette. It searches conversation titles and project names, and includes New
conversation and Open folder actions. Arrow keys navigate while the search
field retains focus; Enter activates the selected action. Escape and an outside
click dismiss the palette and restore focus without cancelling a running turn.
The palette reads conversation indexes from connected, trusted projects when
opened. A failed or unavailable index produces an explicit partial-results
notice and Retry. Search does not start model work or resume sessions by itself.
Conversation history is also loaded when its project is opened; an unopened
group's lack of rows does not imply that the project has no saved conversations.
The model control is one menu inside the composer; the
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
Background work uses a separate column when the workspace has at least 880px
available; narrower workspaces use an overlay without squeezing the
conversation. The panel and conversation widths animate together, and the
project-context control remains mounted during the transition. Large-workspace
context gutters also animate rather than jumping. Closing the panel or pressing
Escape returns focus to its Background work or Changes control; automatic
navigation does not move focus back to an old panel. Reduced motion disables
these transitions. The composer and navigation remain inside the available width.

## Operator flow

Open a folder. If it is not already trusted by Namzu, the app shows its exact
canonical path and a native confirmation before allowing project access. A new
protocol session alone never grants trust. Cancel keeps the folder untrusted.

Choose a saved conversation, or type directly in the selected project’s blank
composer. New conversation and Home return to this blank composer; a runtime
conversation is created only when its first prompt is sent. Suggestions fill the
editor for review rather than submitting a prompt. Navigation during creation
leaves the submitted prompt bound to its captured project and model; it cannot
redirect that prompt or switch the newly selected conversation. A failed provider
selection retains the created conversation and its draft for retry. Saved history comes from Namzu's
existing scoped logs and index; archived conversations cannot be resumed as
writers. The app stores project paths in its own preferences, not conversation
records or provider secrets. Historical display is a bounded text
projection of the latest 200 messages/200,000 characters and marks a partial view.
The kernel loads the full admitted history for the model independently.

Provider and model choices use existing CLI credential discovery. Set up missing
credentials in Namzu. The desktop receives provider IDs, labels and default
model names, never keys or token objects. Opening the model menu asks the selected
configured provider for its real catalogue through `namzu/providers/models`.
This uses the terminal picker's existing bounded listing and access filter;
anonymous routes do not offer models that require an account credential.
The result contains only model IDs, labels, optional notes and a notice. A failed
or unsupported listing keeps permitted default and current choices with an
explicit notice, and the exact-model field remains available. A published model
list is not proof that the account can run every listed model. Listings are read
on demand rather than delaying project startup, shared while one request is in
flight, and cancelled when the CLI connection closes.
The menu has a provider column and selectable model rows with their catalogue
labels. It opens from the start of the model control, with collision handling
at the window edges. Provider glyphs stay in their navigation column; model rows
use their names and selected checkmarks. Repeated provider-wide notes appear
once; distinct model notes remain beside their models. Catalogue notices,
errors and Retry actions have a separate bounded scroll area above the custom
model action, so scrolling model rows does not hide the feedback.
Quick search searches model IDs, labels and provider names across the
configured providers; `/` opens search while the menu has focus. Arrow keys move
through the model choices, and Escape dismisses the menu and restores focus.
Typing in Quick search keeps the search field focused. Arrow Down/Up enters the
first/last matching row; Enter chooses a result and closes the menu. Clicking or
pressing Space on a row also closes it and restores focus to the model control.
Catalogue errors use a readable message and a provider-specific Retry action;
they do not expose raw driver diagnostics or imply that the catalogue is empty.
Fallback notices also remain visible in global search.
The provider tab browses its models without changing the current choice. Use a
model ID remains available for custom endpoints and models absent from a list.
Opening or searching the catalogue does not submit a model prompt or create a
conversation. Navigating to another project or conversation closes the menu.

Sending an idle turn applies the shown
choice before submitting the prompt. Failed selection is visible and prevents
sending on an unintended route. A model change cannot silently kill active work.
Choices last for this connection and survive window reload, rather than editing
global CLI preferences. Existing fallback and delegation preferences remain in
force. Reload also restores live messages, pending reviews and queued prompts
from the main process; it does not restart the running turn.

The adjacent settings menu offers reasoning effort only when the selected model
has known supported choices. The menu uses the existing provider capability
resolution, including configured fallbacks; unavailable settings are reported.
An old explicit choice can be reset to the provider default. Changing the model
clears its previous explicit effort rather than silently remapping it.
Tool permissions use the actual runtime modes: Ask first (`prompt`), Allow edits
(`accept-edits`), Allow tools (`auto`), Preapproved only (`strict`) and Plan
(`plan`). Allow tools remains subject to configured deny rules; Plan refuses
changes. Settings are captured with each submitted or queued message and do not
change the turn already running.

The lower strip exposes Files and Plugins. Files and the paperclip open the
native chooser. Drop files into the editor or paste an image to add their actual
bytes. Supported native inputs are PNG, JPEG, GIF, WebP and strict UTF-8 text.
PDF and other binary files are currently refused in the desktop preview. Image
thumbnails open a full preview; each file has a removal action. A file-only
message can be sent. Each draft/message accepts up to eight files and 3 MiB in
total, with text limited to 128 KiB per file and 256 KiB combined. The main process
retains at most 24 MiB of attachment data across active messages, queues and
drafts. Native paths stay in main; file names, safe previews and bounded metadata
are the renderer's view.

Files belong to their captured project or conversation. Changing folders during
a chooser cannot redirect its result. The first Send moves its draft files and
choices into the created conversation, including a failed route-selection retry.
Window reload restores the unsent text, files, model and settings while main
lives. A queued message keeps its original bytes and settings; Edit restores
them, and Remove releases its files. Cancellation or a provider error returns
active files to the draft for retry. Images reach the actual user-message path;
text files become labelled authored prompt content. The app checks the CLI's
attachment/options capabilities before consuming a draft, and refuses unsupported
explicit requests instead of silently losing their content.
The CLI also refuses new image/document inputs when the selected live provider
explicitly declares that it cannot receive them. Files remain available for
retry with a suitable model. An unknown declaration is not presented as proof
of model support.

Plugins shows installed manifests before the first turn without importing plugin
modules or creating a runtime. After a conversation starts, it displays actual
loaded states. Enable/Disable operates only on an idle conversation without
pending reviews or running background jobs. Choices survive that conversation's
model changes and remain session-local; they do not update startup configuration.

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

Unsent drafts belong to their conversation or blank project in the main process.
A blank project draft survives renderer reload without creating a session,
even when its conversation catalogue cannot currently be read. A newly selected
project waits for its own provider catalogue before allowing Send; the previous
project’s model route is never used during that load. Suggestions are hidden
when a draft is already authored so choosing an example cannot replace it.
Typing that arrives while the first conversation is being created moves into
that conversation’s draft and is preserved when the earlier prompt is sent. Reopening a
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
| `namzu/providers/models` | `provider`, optional `sessionId` | configured provider catalogue; `{ models: [{ id, label, note? }], notice }`, with at most 4,096 rows; default and current choices remain labelled |
| `namzu/providers/select` | `sessionId`, `provider`, optional `model` | acknowledges a session-local choice; active work blocks changes |
| `namzu/providers/settings` | `provider`, `model`, optional `sessionId` | exact supported effort choices/default or a safe notice, without creating a session |
| `namzu/plugins/list` | optional `sessionId` | bounded installed or live plugin inventory and whether it can be changed |
| `namzu/plugins/set_enabled` | `sessionId`, `name`, `enabled` | changes one loaded plugin in an idle conversation and returns its inventory |
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
tool review, model settings, attachments, plugin inventory, message queues and
background shells. Embedded browsing, terminal emulation, remote hosts, native
release packaging and auto-update are not offered in this preview. Source comparisons
and validation receipts are in `research/runtime-desktop-20260930/`.
