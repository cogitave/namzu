# Desktop source comparison and decisions — 2026-09-30

## Pinned sources

Sources were cloned, read locally and not installed or executed:

| Repository | Revision | License |
| --- | --- | --- |
| `pingdotgg/t3code` | `c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21` | MIT |
| `zai-org/ZCode` | `29628c9acdb81b703bbd4080c207a0e7ce5e276e` | Apache-2.0 |

The app implementation is original. No peer assets or implementation files are
copied into Namzu. These references informed behaviors and boundaries, not a
new agent framework or an assertion of matching every feature.

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

The initial renderer presents plain text safely, tool views, tool approval,
reasoning, queues and shell output. Rich Markdown, attachments, browser previews,
terminal emulation, remote hosts and native release packaging need separate
scoped implementations and validation. They are not silently advertised here.

Only project paths are stored in the app's own preferences. Conversation history
remains in Namzu's existing logs. Drafts/queues are currently connection-local;
closing the app is an explicit end of its owned runtime processes.
