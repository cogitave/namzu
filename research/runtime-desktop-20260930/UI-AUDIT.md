# Desktop composition and typography audit — 2026-10-01

## Why the earlier result was insufficient

The previous harness independently rendered primitive controls, but manually composed the surrounding frame and always chose an expanded editor. It excluded the original header artwork/chrome, resting input and attached approval banner. A matching button/composer radius did not establish the requested full-screen design. Those limitations explain the user's repeated rejection; the earlier receipt is not full-screen fidelity evidence.

## Verified sources and comparable conditions

The clean main reference is revision `c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21`. Exact paths and licenses are in `DESIGN.md` and `packages/desktop/THIRD-PARTY-NOTICES.txt`. The independent window now copies original `ComposerSurface`, `ComposerControl`, `ComposerBanner`, `ComposerPendingApprovalPanel`, `WorkspacePageHeader`, `WorkspaceBreadcrumb`, Button, full CSS and the pure blueprint artwork function. It also executes the original `appearanceFonts.ts` default sync, with font-size constants extracted from the pinned contracts file. Verified render branches from SidebarChrome/Sidebar/MessagesTimeline/ChatComposer/ChatHeader provide the surrounding layout and compact/expanded states.

Both Electron windows use the same 1180×791 content viewport, theme, admitted message/tool order, content, draft and scroll offset. The reference receives safe displayed content, not local styles/components. Header artwork uses its original blue palette there and Namzu greens locally. The full peer runtime, account stores, sidebar resizing and tool expansion are not run. Original component appearance and selected composed branches are measured; this does not claim every peer workflow or platform is identical.

## Visible repairs

| Surface | Verified repair |
| --- | --- |
| Sidebar header | Original 80px blueprint SVG and gradual mask/seam, 52px chrome, 28px navigation control, inset brand. Namzu keeps its two-row ASCII identity and phosphor pigments. |
| Navigation | Real desktop collapse/reopen and Ctrl/Cmd+B; persistent preference, focus return, mobile drawer state and accurate aria-expanded. |
| Composer | Original 32px resting editor and absolute 48px action footer; model control moves into the context strip. Focus/multiline expands the same authored draft. |
| Approval | Original attached warning surface, seam, grid/actions and compact command detail. Exact full inputs and destructive markers remain in disclosure; one-batch grant scope is visible. |
| Timeline | User, narration, tools and final messages stay in event-admission order. Turn plus provider call ID owns each receipt, so reusing call_0 cannot overwrite a previous turn. Progress stays in place. |
| Tool rows | Source collapsed-row geometry and icon treatment; corrected 8px shared radius. Actual status/progress and tool output remain available. |
| Typography | Actual reference appearance defaults: root16px, prompt 14px, code 13px, grayscale smoothing. Previous CSS-only audit missed runtime code-size/smoothing defaults. |
| Header labels | Original WorkspaceBreadcrumb component and ChatHeader title branch; 14px medium labels, responsive 8/12px spacing and supported cap/alphabetic text-box trimming replace the former 12px manual breadcrumb. |

Namzu intentionally allows drafting/queuing during approval; the reference disables its editor and hides its normal footer in that state. Namzu's extra exact-batch disclosure and writable editor are therefore recorded as behavior differences, not hidden by a pixel-parity claim. A one-pixel sidebar divider and the ASCII/action/header palette are recorded identity differences.

## Actual font proof

The pinned source does not bundle a body/composer web font. `index.css:156–160` and `appearanceFonts.ts` define platform sans and mono stacks. Empty default preferences leave those stacks in place; contracts defaults are interface 16, prompt 14, code 13 and smoothing=true. `FontAppearanceSync` in routes/__root.tsx applies these values at runtime. The terminal-only symbols font is unrelated to conversation typography.

`platform-fonts.mjs` uses Chromium CSS.getPlatformFontsForNode and an identically styled, explicitly painted text probe. It records direct node fonts separately; textarea's replaced glyph nodes may not be exposed to CDP. Font family, size, weight, line height and letter spacing are compared, and resolved platform font faces must match the independent original window. On this Linux/WSLg host the sans face resolves to Selawik and code to FreeMono. The FontFaceSet contains no loaded custom web faces. This establishes matching platform semantics and actual faces on this host; macOS/Windows can correctly resolve their own native faces.

The expanded/resting/approval comparison JSON files record actual typography, declared styles, direct glyph faces and probe faces for sidebar title/project labels, header title/project labels, editor, prose, code, model and approval detail. Fenced code is 13px with 21.125px line height; prose/prompt 14px with 22.75px line height and normal letter spacing. Header labels are 14px, weight500, line20px; sidebar title is 14px/500 and sidebar project 12px/500.

The extra font-role inspection exposed a flaw in the former comparison adapter: it had manually composed 12px breadcrumb children instead of the original 14px `WorkspaceBreadcrumb` from `chat/ChatHeader.tsx`. The adapter and Namzu now both use the original presentation component and current-title branch, including its supported text-box trimming. Earlier manual-label assertions are superseded by the final role receipts. Narrow Namzu windows hide the project label to retain their conversation title and actions; the original reference keeps a truncated project label. Header titlebar/account actions from the full peer runtime are not imported or advertised.

## Runtime, motion and keyboard evidence

`fidelity-native-receipt.json` comes from actual Electron, CLI ACP and kernel; only model/network I/O is scripted. Real foreground/background/stop processes, three tool approvals and file creation/diff provide the content. Native assertions cover source-state comparison, event order, resting/expanded input, sidebar collapse, narrow drawer, model/project menus, queue/reload, IME Enter and composing Escape, durable history, theme persistence and diff mode/wrap.

The final source/font execution exited 0 with private root `/tmp/namzu-native-smoke-imTs7C`; its log is `/var/tmp/namzu-desktop-breadcrumb-native.log`. The receipt is written after Electron itself closes. Header trimming resolves to `trim-both`/`cap alphabetic`, with 6px vertical padding and matching 21.796875px painted box height in both windows; the wide breadcrumb gap is 12px. Actual font faces also match for every measured child role, including header and sidebar labels.

The composer animates actual layout height for 220ms:50px resting host,122.89px sampled middle,144px expanded host. Its resize observer reserves the evolving dock height in the transcript. Reduced motion produces no height animation. Side panels also have sampled start/middle/settled motion and no animation under reduced motion. The narrow capture uses a600×540 **content** viewport, not an outer-window size.

The separate final continuity receipt proves draft ownership, stale snapshot replay, exact queue editing/removal, late provider/output navigation fences, offline reload, unsubmitted draft reattachment and shutdown after a signalled child. All private experiment processes are test-owned; no user's conversations/jobs were changed.

## Reviewable evidence

- Before: `fidelity-before-approval.png`, `fidelity-before-diff.png`.
- Matched original/local states: `fidelity-{approval,resting,expanded}-{source,local}.png` and matching `-comparison.json`/`-observations.json`.
- Actual interactions: `fidelity-approval-details.png`, `fidelity-focused.png`, `fidelity-collapsed.png`, `native-diff.png`, `native-light.png`, `native-narrow.png`.
- Continuity: `continuity-queue-dark.png`, `continuity-light.png`, `continuity-offline-draft.png`, `continuity-narrow-reduced.png`, `desktop-continuity-receipt.json`.

All files above are under artifacts/. Package build/typecheck/lint and 22 tests pass; root integration owns workspace gates and commit. This remains a private source preview validated on Linux/WSLg. Windows/macOS installers, signing, native credential setup, remote hosts, attachments and embedded browsing are not claimed complete.
