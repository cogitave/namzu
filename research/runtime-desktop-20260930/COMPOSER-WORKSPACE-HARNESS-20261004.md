# Composer, workspace and execution engine audit

## References

The supplied composer image is the geometry reference: an inset context strip
above the main input, project folder and “This computer” on its left, workspace
choice on its right, then attachment/permission controls below left and the
chosen model below right. The requested model icon belongs immediately before
the selected model. The image establishes visible layout, not executable
worktree, voice or external-agent capabilities.

MonoCode's official repository was inspected read-only at
`271b66ded71e795e0569db77c9bbf599219c8cdc`. Its interaction semantics inform the
implementation; its different composer geometry does not override the user's
reference.

- [Composer project/workspace controls](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/features/sessions/ui/Composer.tsx#L2165).
- [Chosen model with harness icon](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/features/sessions/ui/ModelPicker.tsx#L672).
- [Workspace choice and started-session identity](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/features/workspace/ui/WorkspacePicker.tsx#L158).
- [Harness lifecycle contract](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/integrations/harness/core/registry.ts#L52).
- The [official site screenshot](https://www.usemono.dev/app-bg.jpg) was also
  inspected visually. It shows a branch row above the input and the harness
  icon in the selected-model control below.

## Implemented Namzu surface

The ordinary composer now has the attached upper context strip, a functional
project picker, “This computer” identity, and an execution-engine picker. The
picker navigates existing ordinary contexts through the same project handler
as the sidebar. It marks the current project, shows trust/connection state,
excludes Pal workspaces and retains the native Open folder action. Selecting a
row does not grant trust or move an existing conversation into another project.

The lower controls place attachments and permissions left and the selected
model right. A model namespace/family determines a known brand first; a known
provider or a generic local/server or remote/cloud mark supplies the fallback.
No brand is invented for an opaque gateway model ID, and individual model rows
do not receive the new selected-model icon. Existing queue, captured message
settings, attachment admission and compact Pal controls remain the execution
paths.

Source: `packages/desktop/src/renderer/composer.tsx`,
`composer-surface.tsx`, `composer-project-picker.tsx`,
`composer-settings.tsx`, `selected-model-icon.tsx`, `model-picker.tsx` and the
project navigation handler in `index.tsx`.

The execution picker now selects the actual Namzu, installed Codex CLI or
installed `claude-code` route. Namzu uses its canonical wordmark without a
redundant second Namzu label. The external selections launch their respective
native protocols; they are separate from Namzu's `codex` and `anthropic`
providers, which borrow account credentials for Namzu's own kernel. Engine
choice and model-provider choice retain separate identities.

Ordinary conversations have peer tabs with an engine mark and an actual
running-session spinner. Selecting another engine for a started conversation
opens a new conversation; its original engine binding cannot change. Each tab
retains its conversation, transcript and draft ownership. Closing a tab closes
the view without deleting or stopping the conversation. Pal conversations keep
their separate guest admission and cannot use these host-native engines.

Source: `packages/desktop/src/renderer/harness-picker.tsx`,
`conversation-tabs.tsx`, `index.tsx`, and
`packages/cli/src/commands/acp-harness.ts`.

## Implemented native execution

External engines are implemented behind the ordinary conversation's ACP
ownership. Installed Codex runs `app-server`; installed `claude` runs persistent
`stream-json` with native permission callbacks. Their own engines execute their
tools. Namzu does not route those tool operations through `LLMProvider` or
`ToolExecutor`.

Each route discovers models from the installed engine: Codex initializes and
paginates `model/list`; `claude` initializes and requests `list_models`. There
is no synthetic external-engine model fallback. Installation and catalogue
availability do not prove that a fresh inference request is authenticated.
Selection performs no installation or sign-in.

The following inspected MonoCode adapters informed the native lifecycle:

- [Codex catalogue discovery](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/integrations/harness/providers/codex/codexCatalog.ts#L55)
  starts `codex app-server`, initializes, reads account state and paginates
  `model/list`. Its [session adapter](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/integrations/harness/providers/codex/codex.ts#L401)
  owns thread start/resume, streamed turns, approvals and interruption.
- [Claude launch arguments](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/integrations/harness/providers/claude/claudeProtocol.ts#L243)
  establish persistent `stream-json` input/output and permission requests over
  stdio. Its [session adapter](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/integrations/harness/providers/claude/claude.ts#L426)
  owns initialization, native resume identity, partial-message handling,
  tool decisions and terminal results.

The SDK now exposes `createHarnessSession`, normalized harness capabilities and
events, and an owned durable session lifecycle. The original
`session_started.harness` records `{v:1, engineId, profileRef, nativeSessionId,
cwd, initialModel}`. Native identifiers remain opaque and separate from Namzu
session IDs. The engine, host profile and canonical cwd are immutable; later
model, effort and permission selections are recorded per admitted dispatch.
Validation occurs before claiming a writer and again under its actual lease.
Kernel query, resume and recorder entry points refuse external-bound journals;
owned history remains readable without starting an engine.

The authored prompt and operation receipt precede native dispatch. Exact native
item identities preserve live/durable message identity and authoritative final
corrections without deduplicating repeated text. Native tools are recorded as
observations. Reviews keep the exact current native request, turn and immutable
proposal; an approval applies once. Neither interrupt ACK nor a sent review
response proves that native work completed.

Uncertain sends are never automatically resent. Codex reconciles paginated
native history; the installed `claude` stream-json port has no authoritative
history query, so ambiguous work remains blocked. A failed owned-process close
retains its handle and writer for retry. Vendor adapters currently live in the
CLI composition root; the SDK imports no vendor code or credentials.

Source: `packages/sdk/src/types/harness/session.ts`,
`packages/sdk/src/runtime/harness-session/`,
`packages/cli/src/integrations/harness/`, and
`packages/cli/src/commands/acp-harness.ts`. The maintained contracts are
[SDK harness sessions](../../docs/sdk/harness-sessions.md) and
[native conversation engines](../../docs/cli/native-engines.md).

Native Windows launch resolves the real `.exe` rather than interpreting npm,
PowerShell or shell shims, including the installed Codex native package path.
It preserves argv boundaries with `shell: false`, canonical admitted cwd and
captured environment. Shutdown sends EOF first, then uses the exact owned PID
with Windows `taskkill /T /F` if necessary while that root is still owned;
process/pipe closure must be confirmed. A root that exits before its remaining
descendants can be confirmed is a cleanup failure, not a successful stop.
Namzu does not claim a Job Object implementation. MonoCode's
[Windows resolver](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src-tauri/src/harness.rs#L2595)
distinguishes Windows launchers from Unix shell shims; its
[managed Windows process lifecycle](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src-tauri/src/windows.rs#L90)
uses Job Objects; that reference mechanism is distinct from Namzu's current
owned-process transport.

## Worktree prerequisites and evidence boundary

Per-conversation worktree selection is **not implemented**. MonoCode allows
Current checkout, New worktree with a base branch, or an existing worktree
before launch. A started conversation owns that working copy.

Namzu's existing SDK `GitWorktreeDriver` and `WorkspaceRef` describe per-turn
provisioning, distinct from durable `Project.rootPath`. A conversation-level
choice therefore needs persisted execution cwd/branch ownership, actual
provisioning/recovery and resume binding. A checkbox alone would advertise a
capability the host does not perform.

Earlier normal Namzu conversation verification is recorded separately in
[normal-conversation-native-20261004.json](artifacts/normal-conversation-native-20261004.json).
That receipt does not establish external-engine execution.

The current native Windows desktop check separately selected `codex-cli`, sent
an actual prompt with installed-engine model `gpt-6-astra`, and reached
`end_turn` without conversation state errors. The original journal retained a
v1 `codex` harness binding with the real native session identity. The app reopened
that settled journal, continued the same native thread, and ran a printing-only
Windows command through the actual Allow once approval control. Peer tabs had
equal widths and separate drafts; choosing a different engine on a started
conversation opened a new tab and retained the original binding. The Namzu
wordmark was measured and captured without clipping or a duplicate text label.
The final [native engine receipt](artifacts/native-harness-engines-20261004.json)
records these checks separately from the earlier provider-only proof.

Installed `claude` version 2.1.278 returned five models during initialize and
`list_models`; that metadata-only probe sent no prompt. The desktop subsequently
attempted an actual native prompt and displayed the authentication notice while
retaining the engine binding. Local credential inspection found empty
access/refresh values; the current device has no successful native inference
proof for that engine. Deterministic protocol
and SDK-journal integration tests establish ordering, review, identity and
cleanup behavior without claiming a live authenticated `claude` turn.

The initial stream-json surface offers Ask first and Plan. The app-server
surface also offers explicitly confirmed Full access, as recorded below. Attachments,
unsupported native question forms and unsupported effort controls remain
truthfully unavailable; Namzu plugin/grant controls do not govern native-engine
tool loops. Worktree execution remains unimplemented as described above.

Native command approval also exposed Chromium's undelivered resize notification
error. A repeat printing-only command reproduced four browser error events.
Composer-height and transcript follow-scroll writes now coalesce into animation
frames, skip unchanged layout and cancel on unmount. The same live approval/tool
path completed after rebuilding with zero browser errors and zero matching
renderer diagnostics; errors were not filtered or suppressed.

## Windows certificate trust addendum

The desktop's explicit `NAMZU_DESKTOP_CLI` route runs its embedded Node through
`ELECTRON_RUN_AS_NODE`. The owned Windows launch now selects `--use-system-ca`
before the entry point only when `process.allowedNodeEnvironmentFlags` reports
support and inherited `NODE_OPTIONS` has no explicit CA selection. The argv
entry boundary, inherited environment and named installed-CLI fallback remain
unchanged; no certificate files/store, custom CA configuration or TLS
verification settings are rewritten.

[Node 24's documented system CA option](https://nodejs.org/download/release/v24.0.0/docs/api/cli.html#--use-system-ca)
adds OS trust to bundled roots and `NODE_EXTRA_CA_CERTS`. Its
[Node options precedence](https://nodejs.org/download/release/v24.0.0/docs/api/cli.html#node_optionsoptions)
explains why an automatic argv choice must respect an inherited explicit
selection. [Electron's Node launch documentation](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node)
permits Node CLI options in this mode, subject to its documented unsupported
OpenSSL/bundled CA flags. Unsupported runtimes retain their existing strict
behavior. Native catalogue/TLS results belong in the separate receipt above.

## Project, permission and model selection follow-up

The actual native reference client was inspected in Codex mode: project search,
New project, name/Source folders, Add folder on This computer, its native Windows
folder dialog, approval menu, model submenu and reasoning-level control. The
reference dialogs were cancelled without changing a user project or policy.
Its named multi-folder project and automatic approval reviewer exceed Namzu's
current single-folder execution contexts; no placeholder control advertises them.
The documented [project flow](https://learn.chatgpt.com/docs/projects),
[permission modes](https://learn.chatgpt.com/docs/permission-modes) and
[model selection](https://learn.chatgpt.com/docs/model-selection) were checked
against the native observations. The reference default is workspace-write with
on-request approval. Namzu retains its conservative native read-only/untrusted
Ask first mapping and describes that difference explicitly.

The ordinary Namzu menu now exposes Ask first, Allow tools and Plan. Previously
saved legacy modes remain visible without silently replacing their policy.
The `codex-cli` surface exposes Ask first, Full access and Plan. Computer-wide
Full access requires an explicit confirmation scoped to the captured conversation;
cancelling keeps its previous policy. The `claude-code` surface offers only its
implemented Ask first and Plan modes. Engine selection does not grant folder access.

Project search filters actual ordinary contexts. Open folder uses the native
Windows picker and one explicit canonical-folder access decision. Cancelling
leaves the folder untrusted and offers Review folder access; selecting an
already trusted project does not ask again. Don't work in a project opens the
app-owned ordinary chat context, retaining immutable ownership of existing tabs.

Three actual defects were reproduced and corrected during native verification:

- Reloading the renderer lost active/open tab navigation while the main process
  still held the chosen Space Bunny draft. Window session storage now contains
  only navigation IDs. Main-owned project/conversation validation precedes history,
  draft and model restoration. Incomplete reads retain the previous navigation
  for Retry setup; deliberate navigation retires restoration. Send, including
  keyboard submission, cannot run while restoration or view loading is pending.
- Delayed model/engine metadata could overwrite an acknowledged selection.
  Main guards now capture selection revision, client and runtime ownership.
  A stale read is refused instead of adopted. Settings discovery pauses during
  engine selection, dispatch and restoration, then reads the actual settled owner.
  Native reconnect retains the exact unstarted engine/model without replaying a prompt.
- A successful native turn streamed a complete final answer, then supplied a
  terminal receipt without a final item. Its empty settled result erased the
  displayed answer. The adapter now retains its own completed final-answer identity,
  including native history reconciliation. Explicit commentary, unfinished streams
  and foreign-turn items cannot supply the settled answer.

Choosing Default effort resolves the selected native model's actual default on
every turn. Native source inspection established that omitted effort retains the
previous server setting. Deterministic native-wire tests cover high-to-default,
model changes and missing/invalid catalogue defaults; the Windows UI also exercised
High, Default and a model change.

The [native selection receipt](artifacts/composer-selection-native-20261004.json)
records production Electron with normal Windows user data and no browser fixtures.
Namzu sent an actual Space Bunny Free turn and restored its model after reload.
Installed Codex supplied five selectable models, ran GPT-6-Astra, and preserved
its final assistant text in both main-owned history and the reloaded transcript.
The native stream-json engine supplied four selectable models and two permission
presets, then rejected actual inference with a visible sign-in notice. Its engine
binding remained intact; no prompt was replayed through Namzu. Successful metadata
discovery is therefore still separate from native account authentication.

Only the owned test conversation, filtered project picker and permission dialogs
appear in the saved images. Private reference chats and credential payloads are
excluded. Latest verification passed 307 desktop and 5,011 CLI tests, workspace
typecheck/lint, both affected builds, documentation conformance, external-name
audit and the log standard. The earlier whole-workspace run passed 18,715 tests;
the changed packages were rerun after the final fixes. This is local verification,
not a claim that every CI/release gate ran or that the branch was pushed.

## Composer styling and Windows verification

The folder, permission, model and engine controls now use the existing Namzu
popup primitives and tokens. The folder menu has bounded search/results, a
selected-folder check and separated Open folder/Don't work in a project actions.
Permission rows show a label, policy description and selected check; the captured
conversation's explicit Full access confirmation remains the admission path.
Model search, actual catalogue rows, selected state and unavailable notices retain
their existing ownership. Engine choices retain the actual installed-engine route.
Short-window menus scroll within the available viewport, focus returns through
the existing primitives, and reduced-motion styling removes the transitions.
These are observed interaction and styling changes, not a claim of pixel parity
with the reference application.

Ordinary tabs now use the pixel Namzu **N** for Namzu conversations, the respective
native-engine mark for external conversations, and a spinner for running work.
Thin separators distinguish adjacent tabs. The latest
[native tab image](artifacts/composer-polish-tabs-20261004.png),
[folder menu](artifacts/composer-polish-folder-menu-20261004.png) and
[permission menu](artifacts/composer-polish-permissions-20261004.png) show these
states. The [native styling receipt](artifacts/composer-polish-native-20261004.json)
records production Windows Electron, normal user data, keyboard/focus checks,
short-window fitting, and light/dark and reduced-motion checks without fixture
catalogues.

The later authenticated native-engine check supersedes the earlier sign-in
failure reports above: installed Claude Code **2.1.289** supplied **11 models**,
completed the actual reply “Claude giriş kontrolü tamam.”, and retained it after
renderer reload. No new login was needed. The
[Claude reply image](artifacts/composer-polish-claude-reply-20261004.png) is evidence
of that successful account/runtime check; its older full-wordmark tab styling is
historical and is not the final tab reference. An actual GPT-5.6-Sol native Codex
reply was also retained after reload. These inference checks are separate from
metadata discovery and contain no account or credential payloads.

The supplied AppUI Composer Panel image and its implementation establish the
selected-model-row Effort trigger. Namzu now uses that flow: the row's Low/Medium
control opens an Effort panel with a value pill, a discrete slider and the
Faster/Smarter scale. Only the actual supported effort subset supplies its stops;
levels are deduplicated and sorted by effort. The model's actual default stays
implicit until the user changes it, and Use model default restores that omission.
Unknown defaults show Provider default and actual choices before showing a thumb.
An actual custom/unlisted model retains its control in a Current model summary.

The control is a sibling of the model radio button. Directional range/trigger
keys cannot select another model, and Escape closes the inner panel before the
model browser, restoring each trigger's focus. Stale callbacks recheck the
conversation, model generation, current capability set, disabled state and latest
settings callback. A side panel anchors to the complete model row so collision
flipping keeps the model names visible. Windows at 560 × 460 use a vertical
fallback; 700 × 460 and the normal window retain bounded side panels. Theme and
reduced-motion checks exercise the actual portaled controls.

Native Windows verification retained High after reload, restored GPT-5.6-Sol's
Low default, and changed to GPT-6-Astra's Medium default while keeping the model
menu open. Both the chip and range arrow keys retained the same model. The final
[Effort panel](artifacts/composer-polish-model-effort-20261004.png),
[short window](artifacts/composer-polish-effort-short-20261004.png),
[minimum window](artifacts/composer-polish-effort-minimum-20261004.png) and
[light theme](artifacts/composer-polish-effort-light-20261004.png) images record
settled native catalogues. The earlier top-row Effort layout was replaced.

Final desktop verification passed **327 tests across 38 files**, desktop build,
workspace typecheck/lint, and scoped Biome. The whole-workspace run before the
last Effort presentation correction passed **18,763 tests with 116 skipped**;
the affected desktop package was rerun after that correction. These are local
results; the branch has not been pushed and this does not claim all release gates.

## Split and detached conversation windows — proposed, not implemented

Read-only primary-source research supports this interaction:

- [Monocode's pinned split tree](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/features/workspace/model/layout.ts)
  and [pane-drop state](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/features/workspace/model/paneDrop.ts)
  implement nested splits and edge-based pane relocation. This establishes the
  inspected split behavior, not a verified native detachable-window feature.
- [VS Code's editor drop targets](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editorDropTarget.ts)
  distinguish group merging from edge splitting; its
  [native auxiliary-window service](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/auxiliaryWindow/electron-browser/auxiliaryWindowService.ts)
  manages registered window identities and window-specific lifecycle.
- [Dockview](https://github.com/dockview/dockview) provides a candidate MIT layout
  layer for tab groups, splits and restoration. Its
  [built-in popout URL requires same-origin HTTP(S)](https://dockview.dev/docs/core/groups/popoutGroups/),
  whereas Namzu's bundled renderer uses `file://`. Native detachment therefore
  needs an explicit Namzu integration; it is not a drop-in popout call.

The proposed layout is a recursive tree whose leaves contain tab groups. Dropping
at an edge splits that target group; dropping centrally adds a tab. Readable
minimum pixel sizes should govern further splitting, supporting two, four or
eight visible panes when the display can accommodate them. Resize, focus and empty-group collapse belong to the same
layout model. [Dockview's group constraints](https://dockview.dev/docs/core/groups/constraints/)
are not serialized and would need reapplication when restoring its layouts.

Main must retain the existing Operator, ACP connection and native-engine session
when a view moves. A new native window registry must authenticate each owned
webContents/main frame, route snapshots and revisioned events, and preserve the
current preload and navigation restrictions. Detachment should reserve the move,
load the destination, await its snapshot-ready acknowledgement, then commit the
view membership; failure leaves the source view intact. Closing a detached window
should redock its views without stopping conversations. Pending approvals keep
their exact session/turn/request ownership, and stale source-window actions must
be refused.

Current implementation boundaries are `main/index.ts`'s single window/event/IPC
target and Windows close-to-quit behavior, `renderer/index.tsx`'s single active
session and metadata generations, and `conversation-tabs-state.ts`'s shared
storage key. A pane-scoped conversation controller and a main-owned versioned
window/layout record are required. Existing `main/operator.ts` conversation
ownership and the SDK harness journal's exclusive writer lease provide the
runtime foundation. Pane moves retain that writer and its already dispatched
turn. Native Windows dragging across windows, failed-move rollback,
streaming/approval continuity and multi-monitor bounds remain future validation.
No dependency was installed and no split/detach implementation was added during
this research.
