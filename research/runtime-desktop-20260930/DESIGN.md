# Desktop source comparison and decisions — 2026-09-30

## Pinned sources

Sources were cloned and read locally. The full peer applications were not
installed or executed; selected source components and original CSS were later
rendered in an isolated native reference window:

| Repository | Revision | License |
| --- | --- | --- |
| `pingdotgg/t3code` | `c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21` | MIT |
| `zai-org/ZCode` | `29628c9acdb81b703bbd4080c207a0e7ce5e276e` | Apache-2.0 |

The main-process/runtime implementation remains Namzu's existing host work.
After the user's further review, the renderer directly adapts composed source
render branches, not just low-level controls: the main reference's three-row
conversation cards, project-scope menu, titlebar, timeline rows, centred/docked
composer body/footer/context strip, changed-files card and diff surface.
The secondary reference supplies only the compatible error frame. Namzu owns
the data, handlers, runtime and credentials. Brand identifiers and integration-
specific theme selectors do not appear in production source.
Full source revisions, modifications and mandatory copyright/license text are
retained separately in `packages/desktop/THIRD-PARTY-NOTICES.txt` and `licenses/`.
These records are included in build output. No peer logo or other image asset is
used by the app.

## What to use, and why

| Source evidence | Namzu decision | Acceptance |
| --- | --- | --- |
| T3 `apps/desktop/src/window/DesktopWindow.ts:416`, explicit main window isolation; ZCode `packages/desktop/src/main/index.ts:1587` | Electron main owns processes; sandboxed renderer receives a small preload API | Renderer has no Node/credentials/raw RPC; foreign frames cannot invoke UI actions |
| T3 `apps/web/src/components/desktop/RunningThreadKeepAlive.tsx` | Navigation keeps running conversations owned in main | Stream/approval/cancel stay attached to the original conversation |
| T3 `apps/web/src/components/ChatView.tsx`, queued messages and pending approvals; ZCode `packages/ui/src/v4/ConversationComposer.tsx`, draft/input routing | Separate authored drafts, queued next-turn messages and started prompts | Queued text is visible without pretending it already reached the model; stop preserves it |
| ZCode `packages/ui/src/prompt-editor/useComposerToolbarFit.ts` and sidebar collapse components | Sidebar becomes an overlay; toolbar wraps without shrinking the input outside the viewport | Resize wide/narrow/short windows, keyboard focus, reduced motion and IME |
| ZCode `packages/ui/src/ChatErrorBanner.tsx` and T3 local draft error state | Connection/model/tool failures remain visible | No "connected" or "done" state after a failed request; drafts recover |
| Both keep a distinct host/service boundary | Use Namzu ACP plus explicit optional operator methods | Same kernel, provider discovery, config, MCP/plugins, logs and permission callbacks |

Namzu already has durable session leases, tool presentation, scoped background
jobs and cancellation. A desktop app should expose them. It must not recreate
those mechanisms in a renderer or keep another conversation database.

## Current requests checked

Read-only GitHub issue lists were inspected. T3 current reports include hidden
attachment failures (#14371), WSL cold-start routing (#14348), worktree changes
while a turn runs (#14343), invisible unfinished tasks (#14327/#14322) and
Windows auth shadow-home failures (#14325). These are workload/UX acceptance
inputs, not proven Namzu defects. ZCode disables GitHub issues.

Namzu #546/#550/#547 have existing provider-switching, credential-persistence and
picker tests. Desktop model controls must submit the actual selection before a
new turn, acknowledge errors, and keep provider credentials in the CLI host.

## Chosen initial scope

Private `@namzu/desktop` application, not another publishable capability package.
It spawns `namzu acp --desktop` per canonical project. Development can point
`NAMZU_DESKTOP_CLI` at the built CLI entry. No package imports the CLI.

ACP owns prompt/history/cancel/tool review. Opt-in `namzu/*` extensions expose
folder trust, scoped conversation listing/history, safe provider metadata and
session background jobs. The process's canonical cwd fixes extension scope.
Core ACP methods remain available without these extensions. Client initialization
advertises the installed extension names; unsupported installed CLI versions
produce an update instruction instead of a fake working screen.

The renderer presents literal user text and safe assistant Markdown, tool views, tool approval,
reasoning, queues and shell output. Attachments, browser previews,
terminal emulation, remote hosts and native release packaging need separate
scoped implementations and validation. They are not silently advertised here.

Only project paths are stored in the app's own preferences. Conversation history
remains in Namzu's existing logs. Drafts/queues are currently connection-local;
closing the app is an explicit end of its owned runtime processes.

## Direct composition revision after operator review

- Use the source render structure and CSS utilities. Remove independent card,
  composer, message and navigation rules that previously changed its appearance.
  Keep the exact CLI two-row ASCII wordmark and phosphor `#5fff5f` action/focus
  accents; retain neutral source surfaces (`#0a0a0a` canvas and black sidebar).
  Light actions use `#176b29` for readable contrast.
- Keep the 256px sidebar, 52px titlebar, 16px root, 14px conversation type,
  48rem maximum chat width, 78px card, 22px composer radius, 78px minimum
  editor and 28px model control. The context strip is the original surface's
  lower layer rather than an independently styled footer.
- List conversation cards directly; the source project-scope combobox replaces
  redundant project headers. Its title filtering and folder selection operate
  on Namzu state. New conversation and project buttons are real actions.
- Use original centre-to-bottom draft motion and sidebar FLIP/fade helpers,
  native panel easing, source popup transitions and send-button press states.
  Reduced-motion disables travel and fades. Finite motion probes advance browser
  animations explicitly rather than deciding success against elapsed time.
- Display completed ToolCallView file receipts in the changed-files card and
  installed diff viewer with the source CSS adapter. ACP retains the registry's
  completed presentation instead of re-presenting a text-only result without
  its input. No unexecuted proposed write is advertised as a completed diff.
- At wide widths the Changes/Background work panel shares a separate column;
  below the panel breakpoint it overlays. Below 768px the sidebar is hidden and
  inert until explicitly opened. No fake branch, pull request or remote actions.
- `reference-surface.mjs` renders original source components/CSS independently
  of the local styles, with matching viewport/theme/message content/draft/scroll
  offset. It asserts selected component geometry and typography and saves both
  captures. This is a scoped presentation comparison, not a run of the full peer
  application or pixel parity across all screens. `UI-AUDIT.md` records the
  observed scope and intentional brand differences.
