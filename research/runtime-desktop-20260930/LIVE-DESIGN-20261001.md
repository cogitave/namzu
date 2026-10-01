# Live desktop design review — 2026-10-01

## Scope and references

The user asked to review the desktop renderer live in a browser while refining
the design. Work stays in the owned `feat/runtime-desktop-foundation` worktree;
the main checkout remains untouched. The desktop package is private. This
change does not publish packages or add runtime dependencies.

The pinned presentation source remains revision
`c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21` of the primary reference clone.
The user's local `appUI` command-palette, command-menu, dialog and command CSS
are the additional composition reference. They use React Aria; the desktop
uses its already installed Base UI primitives for the same focus, grouping and
action composition. The local reference has concurrent development and is not
represented as an immutable upstream revision. Attribution for redistributed
third-party code and glyphs stays in `packages/desktop/THIRD-PARTY-NOTICES.txt`.

The supplied screenshots establish the visible target, not a verified font or
icon family. The user clarified that the pixel accent ends at the sidebar's
right edge, not at the window edge. The new project reference shows one folder
glyph, plain indented conversation titles and Show more; Search belongs at the
right of the sidebar brand header and opens a centred command palette.

## Decisions

- Keep the Namzu ASCII wordmark and phosphor accent; make only its sidebar
  instance smaller. Use native typography and neutral navigation surfaces.
- Put the ordered two-pixel SVG accent inside the 52px sidebar header. Measure
  the real header width so pixels stay square. It cannot intercept input.
- Round only the sidebar corners facing the rail, clipping the header accent
  inside them. Keep the conversation canvas continuous.
- Use an independent folder disclosure control and project navigation action
  inside one full-width row. The open/closed folder state is real; opacity,
  panel height and selection changes honour reduced motion.
- Show five loaded conversations initially, retaining the active conversation
  beyond that limit. Show more changes presentation, not session ownership.
- Use one command palette from header Search, the Conversations rail action and
  Ctrl/Cmd+K. Populate it with real conversation/project records and the
  existing New conversation/Open folder handlers. Read connected, trusted
  project indexes on opening, and expose partial results with Retry.
- Keep palette dismissal separate from turn cancellation. Selecting a result
  uses the existing admitted navigation and draft ownership paths.
- Preserve input Home/End and Shift selection. Invoking a command lets its
  handler choose focus; dismissal restores the opener. Global shortcuts share
  the visible actions' disabled conditions.
- Allocate no layout height to the mounted empty-results live region while it
  contains no message. The real six-chat preview now gives the list 442px
  instead of 198px; Quick actions are visible instead of being clipped above a
  244px empty region. Long collections retain one bounded native scroller.
- Size Background work against the actual workspace. Below 880px use an
  overlay; larger workspaces animate conversation width and panel position
  together. Keep the context-menu trigger mounted and animate wide context
  gutters. Explicit close/Escape restores the corresponding control's focus.
- Keep model rows compact. Anchor their menu at the control's start; consolidate
  repeated notes and place errors/notices/Retry outside the scrollable model
  list. Provider and exact custom model selection stay functional.

## Development entry points

`pnpm --filter @namzu/desktop dev` builds and watches native code, starts Vite
and opens Electron. `dev:renderer` runs the same preparation without launching
an Electron process. CSS updates in place; TSX changes reload the page. The
native host retains draft ownership through that reload.

The current user review server is `http://localhost:5173/preview`. This separate
development-only browser entry uses clearly labelled sample data and in-memory
preferences. It cannot run a model, native filesystem action or live task. The
native development root uses the real preload API and CLI bridge. Packaged
applications ignore development URLs, preserve their production CSP and exclude
browser fixture output.

An isolated Windows native development window was successfully opened and
observed during this task. It was later absent from the process list; this
record does not claim that the user still has it open. The live browser server
is retained for the user's ongoing review.

## Verification

- [x] Exact loopback development URL policy: four tests; packaged host fallback,
  external URLs and invalid paths rejected.
- [x] Real dev runner readiness, CSP and owned process/server cleanup.
- [x] Real native and browser navigation, grouping, draft preservation and CSS
  HMR before the final project/search refinement, with zero model requests.
  Evidence: `artifacts/dev-preview-native-receipt.json`.
- [x] Wide/narrow, dark/light and reduced-motion final model-menu, wordmark,
  sidebar-only pixel band, rounded corners and folder-state checks.
  Evidence: `artifacts/dev-final-menu-receipt.json`.
- [x] Full workspace tests before the final project/search refinement: SDK
  9,649; CLI 4,732 with five skips; desktop 43. All package test jobs passed.
- [x] Final project/command-palette native and browser interaction proof:
  `artifacts/command-palette-receipt.json` and 15 settled captures. Explicit
  native API seeds verify real cross-project navigation and draft ownership,
  with zero model requests. Modal Escape was checked using a synthetic running
  state delivered through native transport and a real cancel-IPC counter; it
  does not claim that a new kernel/model turn ran.
- [x] Background-work transition proof: 18 actual renderer states, including
  mid-transition reversal, workspace-bound sizing, context-gutter interpolation,
  narrow overlay, reduced motion, preserved drafts and close/Escape focus.
  Evidence: `artifacts/background-work-motion-receipt.json`.
- [x] Final workspace typecheck/lint; desktop 47 tests and production build;
  docs conformance/fences, external-name/log audits and production CSP/sample
  fixture exclusion. The final focus-only renderer edit was checked separately
  without replaying unchanged native session ownership.
- [x] Coherent local snapshot prepared for commit with the required author;
  the live review server is retained. No push or publication.

The historical native proof and newer renderer proof cover different states;
neither is presented as a full rerun after subsequent user feedback. Full
publish/consumer-install CI gates are not claimed for this local design task.
