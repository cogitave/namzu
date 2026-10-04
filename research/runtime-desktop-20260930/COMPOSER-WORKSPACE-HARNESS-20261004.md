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
project picker, “This computer” identity, and a Namzu execution badge. The
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

The badge identifies the actual engine. Namzu's `codex` provider borrows Codex
account credentials for Namzu's own runtime; it does not launch Codex CLI.
Likewise, Claude credentials do not turn a Namzu conversation into Claude Code.
Engine choice and model-provider choice require separate identities.

## External execution prerequisites

External Codex CLI and Claude Code engines are **not implemented** in this
composer. A selectable engine requires an executable route behind Namzu's ACP
ownership, rather than a provider alias or a cosmetic switch.

MonoCode uses real protocol adapters:

- [Codex catalogue discovery](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/integrations/harness/providers/codex/codexCatalog.ts#L55)
  starts `codex app-server`, initializes, reads account state and paginates
  `model/list`. Its [session adapter](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/integrations/harness/providers/codex/codex.ts#L401)
  owns thread start/resume, streamed turns, approvals and interruption.
- [Claude launch arguments](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/integrations/harness/providers/claude/claudeProtocol.ts#L243)
  establish persistent `stream-json` input/output and permission requests over
  stdio. Its [session adapter](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src/integrations/harness/providers/claude/claude.ts#L426)
  owns initialization, native resume identity, partial-message handling,
  tool decisions and terminal results.

A reusable Namzu session port, normalized capabilities/events, durable native
session binding and lease admission belong at SDK boundaries. Vendor process
adapters can live in an optional Namzu leaf package importing SDK; CLI composes
them and routes ACP. The desktop continues to consume normalized views. These
engines own their tool loop and must not be disguised as `LLMProvider` drivers.

Native Windows launch must resolve the actual executable or a known Node CLI
entry point, preserve argv boundaries and own descendant shutdown. MonoCode's
[Windows resolver](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src-tauri/src/harness.rs#L2595)
distinguishes Windows launchers from Unix shell shims; its
[managed Windows process lifecycle](https://github.com/hardbeat920/monocode/blob/271b66ded71e795e0569db77c9bbf599219c8cdc/src-tauri/src/windows.rs#L90)
uses Job Objects. Namzu needs its own corresponding ownership implementation.

## Worktree prerequisites and evidence boundary

Per-conversation worktree selection is **not implemented**. MonoCode allows
Current checkout, New worktree with a base branch, or an existing worktree
before launch. A started conversation owns that working copy.

Namzu's existing SDK `GitWorktreeDriver` and `WorkspaceRef` describe per-turn
provisioning, distinct from durable `Project.rootPath`. A conversation-level
choice therefore needs persisted execution cwd/branch ownership, actual
provisioning/recovery and resume binding. A checkbox alone would advertise a
capability the host does not perform.

Native verification is recorded separately in
[normal-conversation-native-20261004.json](artifacts/normal-conversation-native-20261004.json).
That receipt is the authority for Windows interaction and delivery results;
this source/reference audit does not claim them in advance.

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
