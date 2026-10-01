# Desktop composition correction — 2026-10-01

## Verified source and insufficiency of prior proof

The clean reference checkout is `/tmp/namzu-workflow-peers-20260930.ckQyBT/t3code`, revision `c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21`. The companion reference is `zcode`, revision `29628c9acdb81b703bbd4080c207a0e7ce5e276e`. The prior reference harness independently rendered a handful of primitives, but manually constructed surrounding chrome and the expanded composer. It did not demonstrate the actual full sidebar header, resting composer, or docked approval state. Its previous result cannot establish full-screen fidelity.

Before captures: `artifacts/fidelity-before-approval.png`, `artifacts/fidelity-before-diff.png`. Intentional differences remain Namzu's ASCII wordmark and phosphor palette. No reference logos or product names enter the renderer.

## Concrete repairs

1. Port the actual stateless blueprint artwork from `SidebarStageBackdrop.tsx`, its 80px fade from `index.css`, and the header inset/control composition from `sidebar/SidebarChrome.tsx` and `AppSidebarLayout.tsx`. Make desktop sidebar collapse functional and keyboard accessible, with the existing mobile offcanvas behavior retained.
2. Use the actual resting composer layout in `chat/ChatComposer.tsx`: 32px editor, controls moved into the context strip, footer docked at the lower right. Preserve the expanded multiline/empty-state form, draft continuity and queue editing. Do not disable follow-up drafting during approval.
3. Dock pending approval above the input using the compact panel/actions in `ComposerPendingApprovalPanel.tsx` and `ComposerPendingApprovalActions.tsx`. Show a truthful action summary, exact batch count, destructive marker and complete inputs in a disclosure. Approval continues to target the exact session/request and only grants one batch.
4. Preserve session event order in the conversation projection. Record ordered message/tool entries at event admission; update tool progress in place; never infer ordering from timestamps. Render tools between their actual preceding and following messages.

## Verification

- Focused deterministic projection tests cover tool/message interleaving and progress update stability.
- Native Electron/real CLI probes retain approval, queue, reconnect, offline draft, model, background process and diff checks.
- Capture matching dark, light, narrow, collapsed sidebar, expanded/resting input and docked approval scenes. Inspect geometry, typography, materials, keyboard focus and reduced motion.
- Extend the independent source render with the original stateless header artwork and exact resting/approval branches; record its limited scope honestly. Do not claim the full reference application's runtime was run.
- Package build/typecheck/lint/tests and documentation gate, then notify the parent when desktop source is frozen for full workspace gates.

## Status

Complete on the owned production source. Original header/banner/resting-state
composition is ported; before/after source/local captures are available. The
font audit additionally found the reference's runtime code 13px/smoothing
defaults, which the earlier CSS-only comparison had omitted. Those defaults now
match, and actual Chromium font faces are recorded. Tool receipt identity is
turn-scoped, with a reused-call-ID regression. Independent native review also
found composing Escape cancellation and a misleading narrow drawer aria state;
both are fixed and exercised through the real runtime.

The final header-role check additionally found that the adapter itself had
manually composed 12px breadcrumb labels. The original WorkspaceBreadcrumb and
ChatHeader title branch are now used locally and in the independent reference:
14px medium labels, source line height/gaps and supported text-box trimming.
The final native receipt records these header and sidebar child font roles.

Final package verification: 22 tests, build, typecheck and lint passed. Both
native execution harnesses exited 0 on the frozen source. Full workspace gates
and commit remain with the parent. `UI-AUDIT.md` describes the exact scope,
differences, typography evidence and artifact names.

Final private proof roots: native/source/font `/tmp/namzu-native-smoke-imTs7C`;
continuity `/var/tmp/namzu-desktop-continuity-awKjNT`. Logs:
`/var/tmp/namzu-desktop-breadcrumb-{native,continuity}.log`. Both receipts are
written after owned Electron processes close, and no experiment process remains.
