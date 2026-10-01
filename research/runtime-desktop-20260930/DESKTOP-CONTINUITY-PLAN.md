# Desktop continuity work — 2026-10-01

Status: implemented; final native and package checks recorded below. Owned scope: `packages/desktop`, its existing desktop documentation and this research directory. No CLI/SDK changes or live user sessions.

## Verified baseline

The private native desktop already uses source-derived sidebar/composer/diff controls, Namzu's ASCII wordmark and phosphor accents. The existing native harness covers real CLI/kernel tool execution with scripted model I/O, reviews, queued messages, project trust, models, changes, background shells, narrow layout and reduced motion. Those past receipts describe the prior tree, not the changes below.

`docs/desktop` does not exist; the application page is `docs/cli/desktop.md`.

## Concrete defects and selected changes

- [x] **Unsent draft continuity.** Drafts formerly lived only in the renderer's React state and vanished on window reload. Bounded authored drafts now belong to the main-process conversation, restore on reattachment, survive connection failure and never become model history or credentials.
- [x] **Safe queue editing.** `Edit latest`/Alt+Up no longer overwrites an unrelated non-empty draft. Explicit queued items have stable IDs, accessible inspect/edit/remove actions and accurate next-turn semantics.
- [x] **Navigation ownership.** Explicit navigation generations and target checks prevent late history/provider requests selecting an older conversation and late job output entering another conversation's panel.
- [x] **Native proof.** Real Electron/CLI tests cover reload/navigation, two draft owners, safe queue editing/removal, delayed navigation/output, offline reload, unsubmitted conversation reconnect/send/review and actual app shutdown after a signal. Dark/light, 600×540/reduced-motion and closed-queue source geometry are covered.
- [x] **Delivery.** Package tests/typecheck/lint/build, native flows/reference DOM comparison, screenshots/receipt, documentation and a launch command. Parent integrates whole-workspace gates and commits; no remote write is included.

## Contracts and limits

- This is an application UI state correction. There is no new agent loop, conversation database, A2A transport or Pal deployment registry.
- Drafts and queue remain main-process connection-local: window reload is recoverable, full application quit intentionally ends the owned host state. Do not advertise crash persistence or a native installer without implementing and testing it.
- Editing/removing queued input affects only authored work that has not started. Running prompts are immutable in this surface. Failed/stopped turns do not silently replay queues.
- Preserve the original reference composition, shared accessible primitives, brand tokens, motion/reduced-motion behavior and required license attribution. No reference product name belongs in runtime source or user-facing text.
- Project trust, provider errors and permission ownership stay governed by the existing CLI host. A renderer action cannot widen tool authorization.

## Source comparison for this slice

- Original clones verified clean: `/tmp/namzu-workflow-peers-20260930.ckQyBT/t3code` at `c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21`; sibling `zcode` at `29628c9acdb81b703bbd4080c207a0e7ce5e276e`.
- Main reference `MessagesTimeline.tsx:1779` separates queued items by stable IDs, attributes their actual scheduling status and offers explicit per-item actions. Its `ChatView.tsx:7241` restores authored queue content without silently discarding overflowing material. Namzu uses its existing next-turn admission semantics and does not advertise mid-turn steer where the desktop host has no such method.
- Secondary reference `ConversationComposer.tsx:748` binds drafts to an explicit workspace/session owner and guards delayed persistence against scope changes. Namzu retains small text drafts in its owning main-process conversation; it does not import the reference's renderer store or account/runtime implementation.
- Shared popover, button, typography, colour and motion primitives remain source-derived; queued content has its own accessible pending-work surface. Closing that surface does not change the previously measured conversation geometry.

## Root corrections found during verification

- A native popover focused an invisible portal guard and scrolled the fixed application root 368 pixels horizontally. `#root` now clips instead of owning a scroll container; the transcript/sidebar/panels keep their intentional scrolling. Native geometry asserts root scroll 0, app left 0 and an in-bounds opaque popup. This also keeps the original sidebar and composer composition visible.
- An already signalled runtime has `exitCode === null`; shutdown previously waited for an already emitted `close` event. The transport now tracks actual process closure, with a direct signal-exit regression. The native receipt is written only after Electron itself closes successfully.
- Independent review found that a never-submitted draft disappeared from the reconnect list, and its runtime slot had no durable history to load. Stable host conversation identity is now separated from its replaceable runtime slot. Only never-prompted slots are recreated; started sessions are loaded without replay. Concurrent opens share one reattachment; incoming frames, approvals, models, jobs and catalog IDs use the explicit owner mapping.
- A captured history response could roll back live state that arrived before the response reached the renderer. Host-issued per-conversation revisions now identify included events; only newer events in a bounded in-flight journal are replayed. The native test captures the old queue before an actual removal and checks that releasing the snapshot cannot restore the removed item. A reducer regression also proves included text is not appended twice.
- Approval actions distinguish outlined Decline from primary Allow once. The folder badge is visibly static; the folder-add action truthfully says Open a project, because it opens an existing folder.

## Verification evidence

- Final package verification: 19 passing tests; build, lint, typecheck, docs check and `git diff --check` all passed. Whole-workspace gates belong to the parent integration.
- `desktop-continuity.mjs` runs real Electron, CLI and kernel with only model/network I/O scripted. Private folders and test-owned subprocesses prevent touching user conversations or scheduled jobs. Delayed RPC probes use explicit deferred boundaries, not wall-clock races.
- Final expanded continuity run exited 0; evidence is recorded in `/var/tmp/namzu-desktop-continuity-final.log` and `artifacts/desktop-continuity-receipt.json` (private root `/var/tmp/namzu-desktop-continuity-ph2Dcy`). It verifies six actual agent provider requests, including the reconnected unsent conversation; removed/edited queued text never reaches the provider.
- The original broader native harness also exited 0 on the final source (`/var/tmp/namzu-desktop-existing-native-final.log`, private root `/tmp/namzu-native-smoke-H9FsfV`): real foreground/background/stop, file diff, actual model selection, durable history after app restart, IME, multiline input, searchable project scope, theme persistence and animated/reduced-motion panels.
- Screenshots: `artifacts/continuity-queue-dark.png`, `continuity-light.png`, `continuity-offline-draft.png`, `continuity-narrow-reduced.png`. `continuity-queue-geometry.json` records the visible popup and root bounds. `desktop-continuity-receipt.json` records the actual assertions and request metadata.
- `reference-comparison.json` compares original presentation components/CSS at the pinned main-reference revision, selected render branches and a matching 1180×791 viewport. It does not claim full peer runtime equivalence.
- Earlier probe failures remain in private logs: two harness label/synchronization errors; one launch overlapped the build and therefore loaded old code; subsequent native execution exposed the real signal-shutdown bug. They are not claimed as successful runs.

## Visible affordance audit

| Surface | Actual behavior / restriction |
| --- | --- |
| Search / clear | Filters loaded conversation titles; clear restores the list. Not a global disk-history search. |
| Project filter | Accessible searchable scope picker over opened projects. |
| Open a project | Native directory picker plus explicit folder trust review. Opens an existing folder; does not create a repository. |
| New thread | Actual CLI runtime session. Disabled while no trusted connected project is selected. |
| Conversation card | Actual live projection or bounded persisted CLI history. Late navigation cannot reverse a newer selection. |
| Model picker | Actual available provider metadata and session-local model selection; disabled during active work or disconnection. |
| Provider setup | Uses the configured Namzu terminal application credentials. Native credential/account setup is absent, and the empty-provider notice says what to do. No nonfunctional Connect button is displayed. |
| Composer / queue | Actual send, Shift+Enter/IME, stop, next-turn queue and explicit pending-item actions. Editing is disabled while another draft exists. |
| Folder context | Static owner badge with full path tooltip, not an inert button. |
| Approval | Actual exact permission batch; outlined Decline and primary Allow once. IDs cannot approve another conversation. |
| Sidebar collapse / drawer | Real persisted wide collapse, Ctrl/Cmd+B and focus return. Narrow aria-expanded follows the visible drawer. |
| Approval disclosure | Attached source-style review banner; complete exact inputs, batch scope and destructive markers remain inspectable. Drafting/queuing stays available. |
| Changes / diff | Actual file result inspection, diff modes and wrapping; read-only. No apply/revert actions are advertised. |
| Background work | Actual session-owned shell output/stop. Not terminal emulation or a global job list. |
| Appearance | Real dark/light/system preference, persistent across reload. No unimplemented settings gear is displayed. |
| Attachments / browser / remote host | Not offered; no placeholder controls. |
| Reconnect | Actual child reconnection; preserves authored drafts and does not replay stopped work. |

## User launch and platform limits

From the built worktree:

```sh
NAMZU_DESKTOP_CLI="$PWD/packages/cli/dist/bin.js" pnpm --filter @namzu/desktop start
```

Real native proof covers Linux under WSLg in this environment. The app is a private source preview. Windows/macOS installers, signing, auto-update, attachments, embedded browser and native credential setup are not implemented or claimed ready. Whole-workspace gates, coherent commit and any publication are owned by the parent task.

## Later required fidelity correction

The original primitive comparison did not establish full-screen composition.
`DESKTOP-FIDELITY-PLAN.md` and `UI-AUDIT.md` supersede that claim with original
header artwork, attached approval, compact editor states and actual platform
font inspection. Package tests are now 22. The final native continuity run
(`/var/tmp/namzu-desktop-fidelity-continuity.log`, private root
`/var/tmp/namzu-desktop-continuity-v2Iy9s`) again exited 0 after those repairs.
The later source breadcrumb/font repair also passed this continuity harness
after updating its semantic label selectors. Its final log is
`/var/tmp/namzu-desktop-breadcrumb-continuity.log`, private root
`/var/tmp/namzu-desktop-continuity-awKjNT`. The complete UI runtime/font run
exited 0 at `/tmp/namzu-native-smoke-imTs7C`, logged in
`/var/tmp/namzu-desktop-breadcrumb-native.log`.
The UI runtime receipt is `artifacts/fidelity-native-receipt.json`; source-state
and font proof is in `fidelity-{approval,resting,expanded}-comparison.json`.
