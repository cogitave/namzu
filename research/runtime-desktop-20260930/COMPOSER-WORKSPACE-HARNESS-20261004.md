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

The first native-engine surface offers Ask first and Plan. Attachments,
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
