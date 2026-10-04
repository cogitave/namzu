---
type: Guide
title: Desktop application
description: Local native operator preview, its shared CLI runtime, conversation panes and windows, folder trust, model choices, approvals and background work.
resource: packages/desktop
tags: [cli, desktop, sessions, permissions, workspace]
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
Closing first ends CLI stdin so session and guest cleanup can finish. After a
five-second grace period, Windows force-stops only the still-live owned CMD
process and its descendants with `taskkill /pid /t /f`, then awaits process
closure. It never kills by executable name. A failed OS stop rejects and can
be retried; an already-exited wrapper PID is never targeted. Protocol output
and retained stderr diagnostics use separate UTF-8 stream decoders.
The desktop retains ownership when shutdown fails, blocks new work and reports
the failure. On Windows and Linux its final window stays open until shutdown succeeds;
close it again to retry. A disconnected metadata or project client remains in
the shutdown set until its process closure is confirmed.
The app is not yet distributed through native installers or auto-update.

On Windows PowerShell, select the built CLI entry without a Bash assignment:

```powershell
$env:NAMZU_DESKTOP_CLI = (Resolve-Path .\packages\cli\dist\bin.js).Path
pnpm --filter @namzu/desktop start
```

On Windows, the desktop-owned Node child selected by `NAMZU_DESKTOP_CLI` adds
`--use-system-ca` before the entry point when its embedded Node supports that
flag. This includes Windows trusted roots alongside Node's bundled roots and
inherited `NODE_EXTRA_CA_CERTS`; certificate and hostname verification stay
enabled. An explicit CA option in inherited `NODE_OPTIONS` is preserved, and
unsupported runtimes keep their existing trust behavior. The installed `namzu`
command and standalone CLI trust defaults are unchanged.

Pal computers inherit the CLI's local-engine settings from this native host.
The default is Docker. If this device uses an existing local Podman machine,
set `NAMZU_PAL_COMPUTER_ENGINE=podman` and its verified local machine/connection
settings before launching, as described in [Local Pal computer](../sdk/local-pal-computer.md).
Starting a renderer development server alone does not configure that native
host or start a Pal computer.

### Diagnostic logs

The native host records startup, unhandled main-process failures, renderer
load/process failures and error-level renderer console reports, CLI transport
and stderr diagnostics, failed CLI
requests, unavailable capability notices, and failed IPC calls. An error
caught and displayed by the interface is still recorded at the native IPC
boundary. Pending observation requests cancelled by an explicit owned transport close are
expected cancellation; unexpected exits and OS shutdown failures remain failures.
An asynchronous turn whose successful RPC envelope carries `stopReason: error`
also creates a failure record, without recording its returned history.

Use **Help → Open diagnostic logs** in the native application menu, or
**Ctrl+Shift+L** (**Cmd+Shift+L** on macOS). The files
are `logs/desktop.ndjson` and `logs/desktop.previous.ndjson` inside Electron's
normal application `userData` directory. A trusted native renderer can also
call `window.namzu.diagnostics()` to inspect the exact file paths and whether
storage is available. This method is absent in the browser design preview.
No log destination override is taken from the renderer.

Each NDJSON record has a fixed event/body, severity, timestamp, process
instance and namespaced attributes. CLI request failures include the fixed
method, connection and request correlation, numeric RPC code when supplied,
and recognized failure reason or OS code. For example,
`docker-engine-or-image-required`, `podman-machine-stopped`,
`provider-not-configured` and `model-catalogue-unavailable` identify actionable
failures. Unrecognized errors retain their safe type and `unclassified`
reason. Raw stderr, error messages/stacks, prompts, tool inputs/results,
credentials, project paths and URLs are never stored. Renderer reports include
only a fixed failure kind and numeric source position.
Startup records include the platform and selected local engine, including
`default-docker` when `NAMZU_PAL_COMPUTER_ENGINE` is absent.
Complete CLI stderr lines retain the SDK structured or standard pretty logger's
recognized `debug`, `info`, `warn` or `error` level. Unknown stderr is a diagnostic
warning. INFO/debug output has no failure attributes; the words `JSON` or
`protocol` alone do not establish a protocol failure. Split UTF-8/line chunks
are reassembled with a bounded buffer, and a final partial line is recorded on
stream closure. Raw body and attribute content still remain excluded.

Each file is bounded to 512 KiB; rotation retains one previous file. A burst
above 200 records of one event per second produces one rate-limit record, then resumes in
the next second. Files/directories request owner-only POSIX permissions;
Windows uses the application's userData directory permissions. Redirected log
files/directories are refused; each write checks the original directory's
canonical identity again. Storage failure remains visible through the
diagnostic metadata and cannot replace the original operation failure.

### Live interface development

The development CSP permits the exact local reload connections and local Blob
workers used by Vite reconnection. The bundled renderer retains its production
policy.

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

## Persistent Pals

**New conversation** opens an ordinary conversation, including when a Pal or its
computer is selected. It reuses the current or last available trusted ordinary
project, never a Pal control directory. With no such project, the native host
creates a private normal chat context beneath its application data directory.
Only an app-created, unredirected directory with its exact ownership marker can
receive implicit folder trust. This context is not listed under Projects; its
conversations appear in Recents. In a ready trusted context, New conversation
creates an unstarted conversation slot; it starts no model or native engine.
Normal and Pal drafts, attachments and model choices retain separate
owners. Choosing an existing Pal returns to its owned chat.

The Home sidebar puts **Create your first Pal** directly below New conversation.
After creation it lists each Pal followed by **New Pal**, without a group
heading for the first three. Four or more Pals appear in a collapsible **Pals**
group. Create more than one Pal with a name, appearance and model from the
actual provider catalogue. Give work and preferences through the conversation;
customization does not require a purpose form. Customize uses the saved revision to reject
conflicting edits. Definitions and
conversation ownership come from the [shared CLI and SDK](pals.md), rather than
renderer storage. Existing conversations keep their original profile revision;
profile edits apply to new conversations. A conversation's model choice remains
local to that conversation.

Setup begins inside the conversation with a character, greeting, model picker
and invitation to choose a name. These welcome messages are local interface
content; they do not start a model turn or the Pal's computer. Customize opens a
two-column dialog: color and character choices on the left, editable name and a
large animated preview on the right. Save publishes name, model and appearance
together. A failed save retains the choices for retry. Appearance offers three
original characters (Pixel, Sprout and Spark) in five colors. It is part of the
shared SDK profile, so CLI metadata edits and desktop edits survive restart.
Older profiles without appearance display Pixel in green without changing the
stored revision. An unavailable model catalogue leaves setup and customization
usable; the Pal may use the host's configured model when its own model is null.

The saved Pal view explains its saved purpose and offers customization. Its chat
uses the existing transcript, composer, approvals and tool events. Once setup
saves the profile, the central character disappears. A persistent card on the
right shows its live 3D character, computer, owned recent conversations and
current completed change receipts. The pencil beside the character opens
customization. The card has no menu trigger and reserves its own layout space,
so it never overlaps the transcript or composer. Below 720px of workspace width,
or while a detail pane is open, it stays visible above the conversation with
bounded scrolling. Neither empty outputs nor a disconnected computer imply
completed work. Customizing an existing profile preserves the selected
conversation. Its default model applies to future conversations.

The customization preview and saved Pal card use locally generated Three.js
geometry, loaded only when needed, with idle motion, blinking and pointer
tracking. Pausing freezes the card's scene; resuming restarts it. Hidden or
offscreen scenes stop rendering. Unmount and failed initialization release the renderer, WebGL
context, geometry, materials, textures, listeners and observers. Reduced motion
or unavailable WebGL uses a static character with the same selected appearance.

Each Pal requires its own [local guest computer](../sdk/local-pal-computer.md).
Start computer uses the owning Pal runtime; a missing engine or image produces
an unavailable state with the setup reason. The composer admits work only after
that computer is ready and the Pal is not paused. The card's **Computers** section
shows an actual guest thumbnail beside the Pal computer and a separate host row
from the native device's real hostname. Selecting the guest opens a full content
view, with a persistent noVNC framebuffer stream. PNG captures are used only
for the small card thumbnail; the full view does not poll screenshots.
Offline, capture failure and unsupported control remain explicit states; this
view does not simulate installed apps. The bundled guest supplies a real Openbox
desktop, a themed wallpaper, a tint2 dock and Chromium, Terminal and Files launchers.
Chromium's bundled New Tab page shows the clock, web search and 15 installed
application launchers, including Blender, FreeCAD, GIMP, Inkscape and Draw.
The omnibox is blank on home/new tabs; navigated sites retain their normal address.
The bundled extension and a scoped startup check select that page without
rewriting browser policies or the saved guest profile. Short guest
viewports keep all five-column application rows visible; narrow layouts scroll.
The launchers use a guest-only native messaging host with a fixed extension origin
and fixed application commands. Closing/reopening the browser leaves the desktop
running. Existing images need an explicit rebuild and computer restart for these apps.
Guest browser and file tools do not fall back to the operator's device.

The owning pane places ordinary conversations, Pal chat and the Pal's computer
in one tab row. All use equal 220px by 32px frames inside the same 48px toolbar.
Selecting chat returns to its transcript and profile without closing the computer
tab. Selecting the computer shows its live desktop; the plus button opens or
selects that same computer. Closing its tab returns to the same Pal chat and leaves
the guest running. Keyboard arrows move tab focus and Enter selects; closing the
computer restores focus to chat. These selections do not change conversation navigation;
even a pending first send keeps its owning chat when its session is created.
Changing views invalidates pending guest input and control transfers.

The [native Windows unified-tab receipt](../../research/runtime-desktop-20260930/artifacts/pal-unified-tabs-native-safe-20261004.json)
verified one tab list with these equal frames on the same row. Opening an
offline computer view and clicking back to Pal chat preserved the actual
conversation identity without errors. That check did not start the computer
or verify its live stream.

Layout controls show chat beside the computer, hide it, or place that same chat
in a small floating window. The split header aligns with the two content panes.
The profile control shows/hides the existing card; in a computer view it opens
above the selected pane. A compact chat button on the full computer opens the
floating chat. Its frame expands from that same corner and shrinks into the
circular launcher when minimized; content fades within the changing frame.
Interrupted transitions continue from their current pixel bounds without scaling
text, and reduced motion settles immediately. Exiting content becomes inert
before its animation finishes. Minimizing/restoring, docking and tab selection preserve the
conversation, composer draft, attachments and model choice. These views do not
create an ordinary conversation. Pal chat uses a compact message composer, with
attachment, model and tool settings under its plus control. Ordinary conversations
keep their existing composer.
The Pal menu provides customization, guarded pause/resume and guarded computer
reboot. Delete is shown disabled because the saved Pal deletion contract is not
implemented; it never pretends to delete a profile or persistent volume.

The native host validates the guest's exact generation and keeps its allocation
bearer private. An Origin-checked loopback WebSocket proxy exposes only an ephemeral,
single-view, read-only ticket. The renderer's CSP permits that exact local port.
noVNC draws changing framebuffer rectangles directly to its canvas without React
state or JSON IPC per frame. The view stays connecting until the visible canvas
has presented its first frame at the allocation's exact geometry; a successful
transport handshake alone never enables guest input. Disconnect immediately disables
input and offers a reconnect action; route/generation changes close the old viewer. Older images
report live observation as unsupported until explicitly rebuilt and restarted.

**Take over** verifies the allocation generation, fences new Pal work, cancels
owned foreground turns and confirms background job termination before requesting
exclusive operator control. A failed or uncertain stop keeps the control change
refused. The view then forwards mouse, drag, scroll, text and keys through native
IPC into that exact guest. The host pointer keeps its normal arrow. Coordinates
exclude letterboxing. Text input follows the keyboard layout, including Unicode
and AltGr; Tab remains host focus navigation.
Rapid input is serialized; adjacent pending text is combined into bounded UTF-8
batches without crossing key or pointer actions. Native menu accelerators are
suppressed only while the controlled guest has keyboard focus. Navigation and
allocation, chat layout and focus changes invalidate queued input. Host chat and
popups never own guest input, and returning focus cannot revive retired queued
actions. Deliberate input retirement is silent; genuine transport errors remain
visible. Worker credentials never enter the
renderer. Captures and delayed status
replies cannot certify another generation or replace a newer control transition.

**Return control** restores Pal authority explicitly. Queued work remains parked;
the button stays available during ordinary input and drains queued input before
handoff. Offline states and actual control transitions still disable it.
Returning control does not start a model turn. A later admitted Pal must capture
a fresh screen before GUI mutations. An already warm paused Pal can be controlled
by the operator without allowing model work. Providers without the optional
arbitration port remain view-only. The [SDK and local provider](../sdk/local-pal-computer.md#exclusive-operator-control)
document the boundary, including guest-process limitations.

The top Pal status reveals Pause/Resume on hover or keyboard focus, and Connected
reveals Stop computer in the same position. The card has no separate pause footer.
Stop computer is refused while known turns, queued messages, approvals or
background jobs still own work. Cleanup failures retain a recovery notice and
allow a stop retry. Pausing blocks new admissions, model steps and subsequent
guest operations; it does not itself terminate an already running command.
Customization and pause controls are also guarded while owned work is active.
An unconfirmed background-job stop remains running. Its row displays the
recovery reason and offers Retry stop; only confirmed termination removes that
control. Model status belongs to both the project and selected conversation,
so a delayed landing-page response cannot replace a pinned conversation route.

The native host uses a metadata-only registry connection for saved definitions
and model catalogues. Execution, captures and computer lifecycle requests go
through the Pal's own validated control-directory connection. A new session is
claimed before it is exposed to the renderer. Ordinary project sessions and
another Pal's sessions cannot be adopted. Private control directories are not
listed as ordinary projects or persisted in the desktop's project settings.
The named IPC methods have the same sender checks as ordinary desktop actions;
the CLI's [ACP extension table](pals.md#acp-host-extensions) describes the wire.

The browser design preview supports in-memory creation and customization, and
explicitly reports that a real computer needs the native application. This MVP
does not yet run a resident autonomous loop, Pal Team or external channel adapter.

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
installed inventory in its sidebar and a searchable two-column list in the main
area. Public and Personal are separate tabs: Personal includes installed plugins
from both project and user locations; Public reads separate catalogue entries,
never installation scope. The native desktop has no public catalogue connection
yet and reports that explicitly. The design preview supplies labelled sample
catalogue entries. Compact rows place an icon, name and description beside an
actions menu containing exactly Try now, Manage and Uninstall.
Clicking a row or an installed name in Customize opens a separate plugin detail
page, with a breadcrumb back to Plugins, the complete description and an
Information section. Installation location, version, status, saved startup
settings and errors come from the actual installed inventory record. Public
details show catalogue metadata without claiming installed or startup state.
The existing live
enable/disable control retains the runtime's restrictions. Breadcrumb Back and
Escape retain the list's collection, search and restore focus. Installation
scope remains metadata in Personal rather than a catalogue category.
Long list descriptions wrap within two lines; their complete text remains in
details. Search uses a rounded field. Refresh reloads the same installed
inventory; sidebar Search returns from details and focuses that field. Narrow
views use one column. Manage opens the full detail page. Try now returns to the
current conversation only when that plugin is actually enabled there, preserving
the draft and sending no prompt. Uninstall remains disabled with an explanation
until a desktop uninstall API exists. The page shares its mutation and ownership guards with
the composer menu, including the restrictions on live changes. More offers
Open folder and Toggle sidebar. Profile holds local appearance settings and
does not claim a signed-in account. An update icon is absent until the host can
report an available update. Scheduled is currently unavailable in the desktop
preview; its disabled control never opens a conversation's background shells.
The sidebar brand opens its workspace menu. The labelled New conversation row is the primary
creation action, rather than duplicating it across icon groups.
The dark icon rail has a slightly deeper surface than the conversation sidebar.
Surface contrast separates the rail from the sidebar without a divider. A
subtle 1px line separates the sidebar's right edge from the main canvas.
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
Home opens an ordinary blank composer, using the same ownership rules as New
conversation. The sidebar control or
Ctrl/Cmd+B toggles its list. On narrow windows the same control opens a drawer
below the title bar. Compact conversation rows appear underneath their owning
project groups. Group expansion is independent of project navigation, and opening a conversation
reveals its owning group. Folder glyphs follow the actual open/closed state with
a short crossfade and panel transition; reduced motion disables
those transitions. Running work, pending reviews and errors remain visible
in a reserved area on each conversation row.
An ordinary blank project or conversation centres its composer; the first message docks it with a
short transition. Its inset upper strip shows the project, local computer and
actual execution engine. The project menu switches among ordinary project
contexts or opens the native folder chooser; it never adopts a Pal's managed
workspace. The message box remains expanded. The lower row places attachment,
plugin and settings access beside the permission control on the left, with the
selected model and Send or Stop on the right. Only the selected model trigger
has a model glyph: known model identity wins over its gateway, and an opaque
route uses a provider or generic local/remote symbol. Model rows stay textual.
Send shows a busy indicator while the prompt is being admitted. Model popups
retain their mounted control while focus moves into the menu. The first-message
transition moves the composer from the centre to the bottom and respects reduced
motion; merely focusing the editor does not change its layout. Pal conversations use
the compact, always-docked composer described above; its plus popup keeps model,
permission, attachment and plugin controls accessible. Effort opens from the
selected model's row inside the model picker.
The Background work, Changes and conversation context controls appear in the
workspace header only after a conversation exists. Returning to a blank project
also closes the conversation detail pane.
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
rows. Project headings omit connection dots; connection failures and recovery
remain in the existing project status surfaces. Active and running conversations
remain visible beyond that initial limit. Only the accepted navigation's
originating list highlights the active conversation; selecting Recents does not
also select its project copy or folder.
Folder headings are selected only on a blank project route. Activity indicators
remain shared by both copies. Recents repeats the loaded conversation records
across known projects, deduplicated by session ID and sorted by their saved update
timestamps. It shows the ten most recent records plus any active or running
conversation outside that limit. A recent row opens the same conversation as its project row and reads the
same session state; it does not create another session. Recency reflects loaded
index metadata rather than an inferred visit history or live-event timestamp.
Equal timestamps use the immutable session ID as a final ordering key in Recents
and command search. Opening a conversation or refreshing a project index does
not reshuffle tied records; a newer saved update timestamp can change the order.
Idle timestamps appear on hover or keyboard focus. Running turns show a small
neutral spinner at the right of both rows; stopping the turn clears both
indicators even while another conversation is open. Approval requests retain
their approval icon priority. Pending tools, queued messages and background
shells alone do not imply a running turn. The state area keeps a fixed width to
avoid moving the truncated title; reduced motion leaves the running indicator
visible without rotation. Errors remain visible.
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
Other project groups default to collapsed. Opening a project or a conversation
from its project list expands that group; opening Search or refreshing its
catalogue preserves the operator's expansion choices. Selecting Recents does
not expand the owning project group.
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

## Conversation panes and windows

Drag an ordinary conversation tab to another group's centre to join its tabs,
or before/after a tab to change their order. Dropping near the left, right,
top or bottom edge creates a split when there is enough room for two readable
panes. A tinted preview shows the admitted destination. Dragging a tab outside
the native window opens that conversation in a separate registered Namzu window.
The tab's actions menu also offers Split right, Split down and Move to new window
for keyboard use; split actions appear when the owning group supports them.
Each group selects its own conversation, with its own draft, model, attachments,
queued messages and pending reviews. The sidebar, navigation and application
shortcuts follow the focused group. Namzu tabs use the canonical wordmark's N;
native engines keep their engine marks, and thin separators distinguish tabs.

Splits form a recursive layout rather than a fixed two- or four-panel grid.
Each pane has a minimum width of 380px and height of 300px, with a 4px divider.
The available area determines how many additional splits fit; there is no
four- or eight-pane product limit. Existing splits remain readable after a
window shrinks by retaining the recursive minimum size and allowing workspace
scrolling. Drag a divider to resize its branches, or focus it and use the
appropriate arrow keys; Shift makes a larger step, and Home/End reach the
readable bounds. Keyboard and pointer changes preserve both branches' minimums.
Group controllers keep stable identities when the tree gains or loses a split.

One main-process Operator continues to own all runtime connections across these
views. Moving a tab does not start another SDK loop, restart its engine or replay
its prompt. The main-owned layout grants each conversation one writable window.
A cross-window move reserves the tab while the source saves pending editor
changes and the destination loads its history, draft, settings and attachments.
Both windows acknowledge readiness before main commits the new owner. A failed
or cancelled transfer leaves the source placement authoritative. Closing a
detached window returns its tabs to another open Namzu window without cancelling
their admitted work. Closing the final window uses the normal runtime shutdown.

Main persists the versioned window layout, tab identities, active groups,
split ratios and window bounds in `workspace-layout.json` beneath the native
application data directory. Draft text, attachment bytes, provider credentials
and model prompts are not part of that file. A pending native destination is
excluded until its transfer commits. Restored window bounds are clamped to an
available display's work area; missing displays cannot strand a window offscreen.
Reloading a view reopens its actual main-owned conversations without replaying
messages.

Private desktop state is separate from admitted CLI history. Main saves stable
project and conversation identities, their actual runtime IDs, unsent text,
composer choices and confirmed provider selections in `desktop-conversations.json`
under the native application data directory. Draft attachment bytes live in a
referenced `desktop-draft-attachments.<sha256>.json` file. Attachment changes write
the new blob before atomically replacing its metadata reference; typing updates
the small metadata file without repeatedly encoding image bytes. Preview images
are rebuilt from validated bytes instead of being stored twice. New files request
owner-only permissions on POSIX; Windows uses the application's user-data access
controls. Provider credentials, queued prompts, pending approvals and running
activity are not stored here. A second application launch focuses the existing
native instance so one main process owns the profile.

A cold restart reopens durable history using its saved runtime ID, including
conversations outside the recent catalogue. An unsubmitted conversation has no
CLI journal yet: the desktop keeps its UI and draft owner, creates a replacement
runtime slot, and restores the exact selected Namzu provider/model or native
CLI engine/model before allowing Send. Saved effort, permissions and files remain
with that owner. Restoration failures retain the draft for retry; they do not
substitute another model. Neither reopening nor restoring a draft sends a prompt.

The geometry, ownership and persistence behavior have deterministic coverage.
Native Windows fixture checks verified four and eight panes, independent drafts,
pointer and keyboard divider resizing, centre joins, edge splits, menu detach and
an actual outside-window tab drag. The drag captured mouse-down, drag-start and
drag-end delivery, then retained the draft, selected model and file across two
native windows. The eight-pane fixture measured at least 463px by 652px per pane,
above the product's readable minimums. A full application restart retained empty
conversation UI IDs, draft settings and files while creating new runtime slots
without prompt replay. See the [eight-pane capture](../../research/runtime-desktop-20260930/artifacts/workspace-eight-panes-native-20261004.png)
and [detached-window capture](../../research/runtime-desktop-20260930/artifacts/workspace-detached-native-20261004.png).

A separate native Windows check selected an actual Codex CLI catalogue model
with its default effort, sent one prompt through the composer, and detached its
tab while the real CLI thread was running. The source tab disappeared and the
new native window received live updates while the same main process retained
the single prompt. A read-only command approval arrived after the transfer;
allowing it once in the destination led to the expected successful answer with
no reported errors. The [sanitized running-transfer receipt](../../research/runtime-desktop-20260930/artifacts/workspace-running-native-safe-20261004.json)
records these results without runtime IDs or raw history.

The same real CLI conversation then received a second read-only command prompt.
Its approval was already waiting in the source before another cross-window
move. The destination retained the exact pending approval identity; allowing
it once there completed the second command successfully. The conversation
still contained exactly two authored prompts, with no replay or reported
errors. See the [pending-approval transfer receipt](../../research/runtime-desktop-20260930/artifacts/workspace-approval-native-safe-20261004.json)
and the [workspace-only capture of both settled turns](../../research/runtime-desktop-20260930/artifacts/workspace-running-native-safe-20261004.png).
Closing all three extra native windows acknowledged their closes, returned
their owned conversations to the original window, flushed the latest draft
and retained that two-prompt history without errors; the [native-close receipt](../../research/runtime-desktop-20260930/artifacts/workspace-native-close-safe-20261004.json)
records the result. These actual-runtime checks exercised the installed Codex
CLI; they do not claim equivalent native proof for every provider or engine.

A final cold start of the compiled native app, using normal application data
and native window bounds restoration, also reopened that completed Codex
conversation. It retained both authored prompts, the expected second answer,
the latest unsent draft and the exact selected model, with no replay or reported
errors. The [completed-history cold-start receipt](../../research/runtime-desktop-20260930/artifacts/workspace-running-cold-safe-20261004.json)
records this separately from the earlier empty-conversation restoration.

## Transcript activity and timing

The transcript follows admitted runtime events. Pending approvals show Waiting
for your decision; an active public reasoning block shows Thinking. Tool work
and answer streaming retain their own phase in the projection. An unspecified
model phase remains Working. A provider that withholds reasoning can indicate
an active block without supplying a readable body; the desktop does not expose
opaque reasoning, signatures or replay material.

Each authored prompt owns one turn. Its public reasoning, tool receipts and
explicit commentary stay in admission order inside Activity. Activity opens
while that turn runs and collapses after settlement unless the operator chose
otherwise. The answer appears below that group only when it is a trailing
answer; grouping never moves text across a later tool or reasoning event.
Message and text-part identities preserve distinct responses. Providers without
phase metadata retain their admitted order without invented commentary labels.
An authoritative completion replaces its streamed partial text, including an
explicit empty result that withdraws rejected output.

Cancellation, pause, refusal and error end the live phase without claiming a
successful answer. The exact runtime reason preserves Paused even when its ACP
stop category is `cancelled`. When preparation returns without a streamed end,
the native host admits the prompt response as the missing end once. A streamed
end followed by its response does not create a second completion. Pending
reviews are cleared; authored queued messages remain available after a stopped
turn.

Elapsed time uses the native host's timestamps at prompt admission and turn
settlement. It includes preparation, model work, tools and approval waits; time
spent in an unstarted message queue is excluded. This is observed wall-clock
elapsed time, not provider compute time, billed latency or the sum of tool
durations. Clock adjustments can affect it. Reattaching the interface preserves
the same timestamps and settled duration while main lives. A cold text-history
load has no activity receipts or start/end timestamps, so it supplies neither
reconstructed reasoning nor an invented duration.

## Operator flow

Open a folder. If it is not already trusted by Namzu, the app shows its exact
canonical path and one native confirmation immediately after folder selection,
before allowing project access. Existing trusted folders do not ask again.
A new protocol session alone never grants trust. Cancel keeps the folder
untrusted, with an explicit action to review access again. Folder trust is
separate from the selected conversation's tool permissions and execution engine.
The composer project menu searches existing ordinary projects by name or path;
Don't work in a project opens the app-owned ordinary chat context. Neither
project navigation nor opening the permission menu grants folder access.

Choose a saved conversation, or type directly in the selected project’s blank
composer. New conversation, Home and the tab plus button create a blank ACP
conversation slot in a ready trusted ordinary project; neither a model nor an
external engine starts until a prompt is sent. Disconnected or untrusted contexts
show the blank landing composer until preparation is possible. Ordinary peer tabs
retain separate drafts, models, queues and approvals. Closing a tab only hides its
view; reopening a recent conversation restores it. Empty tabs are omitted from
the sidebar recent list. Suggestions fill the
editor for review rather than submitting a prompt. Navigation during creation
leaves the submitted prompt bound to its captured project and model; it cannot
redirect that prompt or switch the newly selected conversation. A failed provider
selection retains the created conversation and its draft for retry. Saved history comes from Namzu's
existing scoped logs and index; archived conversations cannot be resumed as
writers. The app's private records retain project paths, conversation identities
and acknowledged drafts separately from that history, without provider secrets.
Historical display is a bounded text
projection of the latest 200 messages/200,000 characters and marks a partial view.
The kernel loads the full admitted history for the model independently.

Provider and model choices use existing CLI credential discovery. Set up missing
credentials in Namzu. The desktop receives provider IDs, labels and default
model names, never keys or token objects. The top composer strip chooses the
execution engine. Namzu uses its wordmark without a duplicate text label and keeps
its own provider/tool runtime. `codex-cli` and `claude-code` use the installed native
engine and its actual model catalogue, surfaced under separate engine IDs. An
existing conversation keeps its durable engine; choosing another engine opens a
new peer tab. Selection is reflected immediately after the engine acknowledges
it, even if later model discovery fails. Model, permission and attachment
controls are disabled while engine selection is pending. A project reconnect
reapplies the exact engine and selected model for an unstarted native draft;
failure retains that draft and never replays its prompt through Namzu.
Failed saved-settings reads keep Send and model selection unavailable until
Retry setup retrieves the actual saved choices, rather than choosing a default.
Renderer reloads retain ordinary open tabs, groups and active conversations in
the main-owned window layout. Tab identities are revalidated against the actual
project and conversation catalogue before history, drafts and settings reopen.
Failed or incomplete restoration keeps the previous navigation for Retry setup
and disables Send/model controls; deliberate navigation starts a fresh view.
No model choice or draft text is duplicated in browser storage.

The ordinary Namzu permission menu offers Ask first, Allow tools and Plan.
Previously saved Allow edits and Preapproved only policies remain visible without
changing the stored policy. Codex offers Ask first, Full access and Plan; choosing
Full access requires an explicit confirmation for the captured conversation.
Its existing conservative Ask first mapping uses native read-only/untrusted
policy; it is not the current Codex app's workspace-write approval default.
Full access is computer-wide native access without tool review. Namzu Allow tools
continues to respect Namzu's configured tool rules and is not labelled Full access.
The initial `claude-code` adapter offers Ask first and Plan only. The app does not
offer Codex's automatic safety reviewer. Native engines disable attachments and
Namzu plugin toggles rather than discarding inputs.
See [native engines](native-engines.md) for installation, sign-in, cancellation
and recovery limits.
Composer height and transcript follow-scroll writes are coalesced into animation
frames and skipped when unchanged. Resize callbacks do not immediately change
the sibling transcript layout, so native approval banners can appear and close
without undelivered resize notifications. Pending writes are cancelled when the
view is replaced.
An installed executable does not prove that a usable account session was found.
See [provider credentials](credentials.md#existing-claude-sessions) for the
native Windows credential locations and explicit profile overrides.
Opening the model menu asks the selected
configured provider for its real catalogue through `namzu/providers/models`.
This uses the CLI's existing bounded listing and access filter;
anonymous routes do not offer models that require an account credential.
The result contains only actual listed model IDs, labels, optional notes and a
notice. Registry defaults and saved choices absent from that list are not added
as available rows. The current choice remains visible in provider status, with
an explicit notice when the catalogue omits it. A failed, timed-out or unsupported
listing returns no invented rows; its notice explains the failure and the
exact-model field remains available. Credential rejection has a distinct safe
notice without the driver's raw diagnostic. A published model
list is not proof that the account can run every listed model. Listings are read
on demand rather than delaying project startup, shared while one request is in
flight, and cancelled when the CLI connection closes.
The account catalogue uses the driver's strict listing when available, keeping
an authentication or network failure distinct from its legacy bundled menu.
The menu has a provider column when more than one provider is available and
selectable model rows with their catalogue labels. A single provider uses a
compact list. The menu opens from the end of the model control, with collision
handling at the window edges. Provider glyphs stay in their navigation column; model rows
use their names and selected checkmarks. Repeated provider-wide notes appear
once; distinct model notes remain beside their models. Catalogue notices,
errors and Retry actions have a separate bounded scroll area above the custom
model action, so scrolling model rows does not hide the feedback.
Quick search searches model IDs, labels and provider names across the
configured providers; `/` opens search while the menu has focus. Arrow keys move
through the model choices, and Escape dismisses the menu and restores focus.
Typing in Quick search keeps the search field focused. Arrow Down/Up enters the
first/last matching row; Enter, clicking or Space chooses a result. The composer
keeps the model menu open so its selected row can expose effort. Escape dismisses
it and restores focus to the model control. Profile-only model pickers close
after selection because they do not edit a conversation's effort.
Catalogue errors use a readable message and a provider-specific Retry action;
they do not expose raw driver diagnostics or imply that the catalogue is empty.
Fallback notices also remain visible in global search.
The provider tab browses its models without changing the current choice. Use a
model ID remains available for custom endpoints and models absent from a list.
Opening or searching the catalogue does not submit a model prompt or create a
conversation. Navigating to another project or conversation closes the menu.
An idle Pal can browse and choose models while its computer is stopped,
unavailable or paused. Catalogue access requires its own connected, trusted
workspace and loaded provider settings. Sending still requires a ready computer
and an unpaused Pal; active work continues to block model changes.
The Pal landing retains its saved model label while provider metadata loads.
Existing conversations retain their claimed model route rather than adopting
an edited Pal default.

Sending an idle turn applies the shown
choice before submitting the prompt. Failed selection is visible and prevents
sending on an unintended route. The CLI checks the chosen access path and
supported wire before closing the old model session; an anonymous Zen choice
that needs a credential leaves the previous conversation intact. New session
creation itself does not require a provider credential, so an unavailable saved
provider can be replaced before the first prompt is prepared.
Before that turn creates its journal, scoped model preparation accepts only
the normal session actually published on the current ACP connection with this
exact canonical workspace. Unknown IDs, foreign workspaces and stopped slots
remain refused; Pals still require their explicit durable claim.
A model change cannot silently kill active work.
Choices last for this connection and survive window reload, rather than editing
global CLI preferences. Existing fallback and delegation preferences remain in
force. Reload also restores live messages, pending reviews and queued prompts
from the main process; it does not restart the running turn.

The selected model row offers reasoning effort only when the actual model has
known supported choices. Its effort chip opens a small panel beside the row;
at window widths of 600px or below, the panel opens below the chip. A discrete
slider contains only that model's supported levels, ordered from lower to higher
effort, with the actual level named above it. Default restores the model's
reported default rather than persisting a guessed slider position. Capability
resolution includes configured fallbacks, and unavailable settings are reported.
An old unsupported explicit choice has a Reset action. Changing the model clears
its previous explicit effort rather than silently remapping it. These controls
capture the model and conversation owner, so a late interaction cannot modify
another selection.
The underlying Namzu permission modes remain Ask first (`prompt`), Allow edits
(`accept-edits`), Allow tools (`auto`), Preapproved only (`strict`) and Plan
(`plan`). Allow tools remains subject to configured deny rules; Plan refuses
changes. Settings are captured with each submitted or queued message and do not
change the turn already running.

The attachment/settings popup exposes Attach images or files and Plugins.
Attach images or files opens the native chooser. Drop files into the editor or paste an image to add their actual
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
Window reload and application restart restore acknowledged unsent text, files,
model and settings from private desktop storage. A queued message keeps its
original bytes and settings while main lives; Edit restores
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

Unsent drafts belong to their conversation or to a blank project composer scoped
to its window and tab group in the main process. A blank project draft survives
renderer reload and application restart without creating a session,
even when its conversation catalogue cannot currently be read. A newly selected
project waits for its own provider catalogue before allowing Send; the previous
project’s model route is never used during that load. Suggestions are hidden
when a draft is already authored so choosing an example cannot replace it.
Typing that arrives while the first conversation is being created moves into
that conversation’s draft and is preserved when the earlier prompt is sent. Reopening a
conversation after a window reload restores its acknowledged draft, even while
the runtime connection is unavailable. Each draft accepts at most 50,000
characters; the application retains at most 1,000,000 draft characters across
open conversations. A refused save remains visible as an error. Acknowledged
drafts are saved in private desktop storage; they are not model messages or
admitted CLI history. Queues, pending reviews and running activities remain
connection-local and end when the application quits; they are never replayed
from the draft store.

A draft-only conversation keeps its tab after reconnecting or restarting. Because
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
| `namzu/providers/models` | `provider`, optional `sessionId` | configured provider catalogue; `{ models: [{ id, label, note? }], notice }`, with at most 4,096 actual listed rows; unavailable selections and failed lists have explicit notices |
| `namzu/providers/select` | `sessionId`, `provider`, optional `model` | checks access and supported wire before replacing a session-local choice; active work blocks changes |
| `namzu/providers/settings` | `provider`, `model`, optional `sessionId` | exact supported effort choices/default or a safe notice, without creating a session |
| `namzu/plugins/list` | optional `sessionId` | bounded installed or live plugin inventory and whether it can be changed |
| `namzu/plugins/set_enabled` | `sessionId`, `name`, `enabled` | changes one loaded plugin in an idle conversation and returns its inventory |
| `namzu/jobs/list` | `sessionId` | this session's jobs |
| `namzu/jobs/read` | `sessionId`, `jobId` | retained chunk, offsets and dropped-byte count |
| `namzu/jobs/stop` | `sessionId`, `jobId` | stopped job |

The native main process owns these methods. Its preload exposes only named UI
actions, and checks the requesting registered window, exact web contents,
main frame and renderer URL. Node integration is disabled, context isolation
and renderer sandboxing are enabled. Arbitrary renderer navigation,
`window.open` and webview attachment remain blocked. Detachable workspace
windows are created and registered explicitly by main under the same policy.
The built UI has a restrictive
content policy. Model and tool text is rendered as text, never executable HTML.

## Current scope

The preview covers local projects, conversation history, tab groups, split panes,
detachable native windows, formatted replies,
tool review, model settings, attachments, plugin inventory, message queues,
background shells and persistent Pals with local virtual computers. Each computer
runs its installed browser, terminal and Files applications; its live desktop
supports exclusive operator control. Remote hosts, native release packaging and
auto-update are not offered in this preview. Source comparisons and validation
receipts are in `research/runtime-desktop-20260930/`.
