# Desktop shell reference update

The operator supplied a new Windows screenshot as the visual target: one slim
window bar, a persistent icon rail, a separate project/conversation list, and a
centred empty-state composer. This supersedes the earlier shell composition.
Existing adapted controls, approvals, model selection and diff views remain in
use. Namzu retains its two-row ASCII wordmark and phosphor accent.

## Observed reference and implementation

The reference is a screenshot, so its DOM, zoom, actual font face and motion are
not available. Measurements below describe the implementation, not a claim of
pixel parity with an inaccessible reference DOM.

- One 32px window strip replaces the default caption plus separate menu row.
  Native caption buttons and resizing are retained. File has working local
  actions; Edit, View and Window open the operating system's menu implementation.
- The 48px icon rail stays visible when the 288px sidebar collapses. Home,
  Projects, Conversations and appearance have real actions; Back, Forward and
  the sidebar toggle occupy the title bar.
- Projects and compact conversation rows occupy separate sections. Review,
  running and failure indicators still describe the actual conversation.
- A trusted project's empty view presents a 640px maximum composer. Suggestions
  populate its draft; they do not run a model. The first Send creates a session.
  The expanded 94px main message surface keeps its model and Send controls
  mounted in the lower row. Focusing it retains height, position and picker
  identity instead of remounting an open model popup.
- The shell uses subdued neutral surfaces with the existing accent. Fonts still
  resolve from the operating system's sans and monospace stacks.
- Sidebar and composer motion retain reduced-motion handling. A 600×540 window
  exposes the sidebar as a drawer below the window bar with no horizontal overflow.

## Additional source references

The supplied Work screenshots add an expanded editor with a lower control row
and project context extension, plus a quiet transcript and right summary card.
The local appUI project was inspected at
`/home/arda/workspaces/@cogitave/cogitave-labs/appUI`, specifically
`components/blocks/composer-panel/composer-panel.tsx`,
`components/blocks/composer/composer.tsx`, `styles/composer-panel.css` and
`components/base/card/card.tsx`. Its 102px panel, 24px corners, action-row
composition and card roles informed the adaptation. It is a concurrent non-Git
working copy with no license declaration found; no clean or pinned-state claim
is made and no files there were modified. Namzu retains its own admission,
queuing, draft and model semantics and existing accessible controls.

The pinned ZCode source (`29628c9acdb81b703bbd4080c207a0e7ce5e276e`) was inspected
in `packages/ui/src/v4/ConversationStatusPanel.tsx`, `conversationLayout.ts` and
`conversationStatusPanelModel.ts`. Its container-responsive status card informed
Namzu's 300px card with 16px padding/radius/offsets. At a workspace container width
of 1280px it reserves conversation/composer space; below that it becomes a
compact Project context popup. Native checks used 1700px and 1580px content
widths with the sidebar visible, demonstrating that a wide viewport alone does
not expand the card. Both rows open actual Changes and Background work panes;
opening a detail pane removes the summary. Resizing also dismisses a popup whose
trigger becomes hidden. Counts describe available completed diff receipts and
verified session-owned running jobs. Loading and failed job reads remain unknown.
No subagent, artifact or source inventory is inferred from tool text.

## Ownership verification

`shell-preview.mjs` uses native Electron, the real CLI and kernel, isolated
application/trust/project storage, and a scripted model transport. Its deferred
IPC wrappers hold actual admissions; they do not simulate session ownership.
`shell-native-receipt.json` records:

- zero session creation from idle editing, Home, New conversation or Ctrl+N;
- project draft restoration after renderer reload;
- one first-send creation despite repeated Enter, with later typing retained;
- a prompt bound to its captured project/model after intervening navigation;
- model-selection failure followed by retry in the same created session;
- three actual scripted model requests and the real tool approval interface;
- light, narrow, IME, drawer dismissal, reduced motion and renderer isolation;
- exact header/rail order, one New conversation row and workspace-menu focus;
- real Back/Forward draft restoration and wide Projects/collapse interactions;
- catalog failure preserving the independently owned draft, and project-scoped
  provider admission disabling Send/Enter until the actual catalog arrives.

The macOS caption-colour update deliberately avoids the Windows/Linux-only
`setTitleBarOverlay` API; macOS keeps native traffic lights and theme changes.
No macOS native run was performed for this revision.

The user's native Windows preview has an actual WSL CLI backend. A separate
Win32 probe verifies caption hit testing (drag=2, minimize=8, maximize=9,
close=20, menu=client/1), plus maximize, restore and minimize. This preview is
not an installer or a claim of a Windows-native CLI engine. No model prompt
was submitted to the user's backend during these shell checks.

## Local checks

Desktop build, typecheck, lint and 27 tests passed. Docs conformance and compiled
fences passed. Full workspace typecheck, lint and tests passed; existing CLI
lint warnings remain warnings. The final context-card changes passed typecheck/lint, desktop
build and native checks; no kernel/package behavior changed in that refinement.
The full native receipt verifies actual foreground/background/stop commands,
file diff, queue and review restoration, theme, model menu, container layout and
focus stability. Only model/network I/O is scripted. The Windows receipt and
screenshot verify the actual native preview backed by the WSL CLI, without
sending a user-model prompt. Those artifacts live alongside this note. Earlier 48-gate receipts belong to
the previous committed source; this UI revision does not claim those gates were
rerun and is not being pushed or published.
