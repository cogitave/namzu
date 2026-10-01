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
- Use one command palette from header Search and Ctrl/Cmd+K. Populate it with real conversation/project records and the
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

## Follow-up rail and Plugins correction

The user corrected the navigation contract after the original snapshot. The
rail is Home, Spaces, Scheduled, Plugins and More, with Profile at the bottom.
Home owns chat views; Spaces exposes the actual project list. Search stays in
the sidebar header and Ctrl/Cmd+K. More opens existing folder/sidebar actions;
Profile offers actual local appearance settings without an invented account.
Scheduled has no desktop bridge and stays explicitly unavailable, distinct from
background shells. There is no update badge without an actual host signal.

Plugins is a full Customize destination: installed names in the sidebar,
searchable cards in the main pane, and All/Project/Personal filters over actual
inventory scopes. The composer and page share admission, busy and scope/generation
guards. Informational notices remain informational and do not suppress search
empty states. No marketplace or third-party installations are fabricated.
Changing destination retains the conversation, its drafts and its attachments;
successful chat navigation explicitly returns to the chat view. Escape on the
Plugins page does not cancel hidden conversation work.

The shell's visible panel owns its rail-facing rounded corners, including the
chat canvas when the sidebar is collapsed and the narrow layout. The rail's
divider is removed; the rail and sidebar use surface contrast. The sidebar's
right edge retains a subtle 1px divider, restored after the user clarified
which boundary should remain visible.
New conversation has a 4px top margin, 2px more than the preceding snapshot.

Prior executable proof scripts now select appearance through Profile and use
the current Spaces/header-search controls. Their historical receipts were not
rewritten or represented as native reruns for this correction. The separate
`rail-navigation-proof.mjs` covers the current renderer interactions with
explicit browser fixtures; its receipt identifies that verification boundary.

The final correction passed seven current browser captures: default sample
plugin cards, an injected read-only inventory, retained chat drafts, collapsed
sidebar corners, and narrow light/reduced-motion views. At that snapshot both
navigation borders measured 0px; the visible panel clipped its 16px corners.
The subsequent right-edge correction is recorded separately below. The default plugin cards
are explicitly labelled development sample data and expose no runtime controls.
No model requests, plugin mutations or background-job stops occurred.

Workspace typecheck, desktop lint, docs conformance, external-name/log audits,
the 47 desktop tests and production build passed. The full workspace test run
preceded the final page/focus/fixture refinements; the focused renderer proof and
final static/build checks cover those refinements. Production output retains
its restrictive CSP and excludes the development preview and sample data.
This is a local design correction, with no fresh native-kernel proof, push or
publication.

## Follow-up Plugins reference density

The user identified another mismatch: the reference uses plain compact rows,
not large raised cards. The supplied screenshot suggests about 900px of main
content, 36px icons, 12px icon-to-copy gaps, two columns with a 48px gutter,
14px names and 13px descriptions. These are image measurements/inferences;
the reference application's DOM and exact font family were not available.

The implementation now uses that icon/content/action composition. A 960px
frame including 24px side padding provides 912px of content at wide sizes;
the title begins 28px below the native title bar. Search is a 32px rounded
field, scope filters are 36px pills, and ordinary rows have a 68px pitch with
transparent backgrounds and no enclosing border. Longer descriptions clamp
to two lines; their full text and version/status/startup information remain
available in the row's details popover. Narrow workspaces use one column.

The right-side details button operates on the real installed plugin record.
Live enable/disable actions retain the shared inventory guards. Refresh reads
the existing inventory API and is disabled during a plugin mutation; context
keys close old details on ownership changes. The Customize sidebar's Search
button focuses the main search field. No public catalogue, installation action,
promotional banner or unavailable integration logo is inferred from the image.
The sample preview retains its explicit data notice; native inventory is
unchanged. Previous card captures remain historical evidence, not current UI.

The focused `plugins-reference-proof.mjs` passed on the final source, recording
four current captures and `artifacts/plugins-reference-receipt.json`. At
1609×973 dark and 600×540 light/reduced-motion, ordinary rows measured 68px and
long-text rows 86px, without page overflow. The proof exercised search, scopes,
one explicit inventory refresh, details/Escape focus and sidebar search focus.
Its data is browser-only sample/synthetic inventory: no plugin mutation or
model request occurred, and no native runtime result is implied. Workspace
typecheck, desktop lint, 47 existing desktop tests, docs conformance,
external-name audit and final production build passed. The live review server
is retained; no push or publication was performed.

## Sidebar right-edge correction

The user clarified that only the rail-side divider should be removed. The
shared sidebar now restores its 1px `--sidebar-border` right edge, covering
both conversations and Customize. The rail stays borderless. The renderer
proof script's expected sidebar border width is updated without rewriting historical
captures; this correction does not change the corner or ownership rules.

## Plugin collection and full detail page

The user requires Public and Personal tabs. The prior implementation confused
these with project/user installation scope. Personal now searches all installed
records; Public reads an independent optional catalogue list. The native bridge
does not supply that catalogue and shows an explicit unavailable state. The
browser design preview supplies clearly labelled sample catalogue entries.
The backend still discovers project and user locations according to trusted
configuration. That technical scope is metadata in Personal's Information,
not inferred public visibility.

The supplied detail reference uses a separate page: a breadcrumb at the top
left, roughly 720px of centred content, an icon above a title/action row, and
an Information section. Plugin row names/icons and installed sidebar names
now open that page. It shows the full real description, installation, version,
status, saved startup setting/error and existing live enable/disable action.
Public details show only catalogue metadata and its notice. No unavailable apps,
sample prompts, integration imagery or share/install controls are invented.
The row's three-dot menu contains exactly Try now, Manage and Uninstall with
stock outline glyphs. Manage opens the detail page. Try now requires an actually
enabled plugin in the current live conversation and returns to its composer
without sending or changing the draft. Uninstall is disabled with a truthful
explanation because the desktop bridge lacks that operation. Heading focus,
Escape, breadcrumb Back and sidebar Search navigate
without URL changes; Back preserves the search and restores a visible row or
search control. Owner key/generation checks prevent old selections and delayed
focus from returning after context changes. Operation errors retain the plugin
identity rather than appearing in another plugin's detail page.

The narrow Customize header reserves room for Close beside Search. An earlier
pointer test found a 24 by 22px overlap; the final proof establishes distinct
hit targets and verifies a normal pointer click on Search closes the overlay
and exposes the focused search field.

### Final plugin proof

`plugins-detail-proof.mjs` passed in one isolated localhost browser context,
with six screenshot/measurement pairs and `plugins-detail-receipt.json`.
The captures cover wide dark Public actions and Personal inventory/details,
an explicitly synthetic pending action, and narrow light long descriptions
and return navigation with reduced motion. Public uses explicit catalogue data;
omitting it shows the unavailable state. Personal includes both installation
locations. The exact three-item menu, disabled capabilities, Manage heading
focus, enabled live Try returning to the retained composer without a send,
cross-collection query reset, same-collection query retention, A→B→A ownership,
busy guards and mobile pointer navigation all passed. There were eight inventory
reads, zero sends and zero native changes; the sole mutation dispatch resolved
an owned-page fake promise and is not native-runtime evidence.

A focused isolated-browser failure check also passed after restoring the empty
state guard: a rejected inventory read reports its load error and Retry control
without claiming that no plugins are installed. No native operation occurred.

The retained older proof scripts use the current selectors and collection
semantics; their historical captures were not rewritten. Workspace typecheck,
lint and tests (including 47 desktop tests), docs conformance for 129 pages, external-name audit
and the final desktop production build passed. The packaged renderer retains
its production CSP and excludes the development preview and sample catalogue.
The live renderer server is retained; no push or publication occurred.

## Session activity in Projects and Recents

The user supplied a reference with a small trailing spinner and the same
conversation under both Projects and Recents. A shared ThreadCard now renders
a neutral 12px running indicator from the existing session projection, retaining
approval priority and visible errors. A fixed 28px state slot keeps the title
and row width stable; reduced motion leaves the indicator static. Background
jobs, pending tools and queues do not substitute for a running turn.

Recents is a separate sidebar collection of the loaded ConversationView records
across known projects, deduplicated by session ID and sorted by saved updatedAt.
Its first ten records retain active/running sessions outside that cap. Project
lists similarly retain running sessions beyond their initial five rows. Both
occurrences use the same session state and openConversation callback; they are
display copies of one session. The existing motion implementation owns each
list separately. Recency does not claim that an unloaded project's index or an
unobserved external session has been read, and does not invent live timestamps.

`sidebar-activity-proof.mjs` passed with three screenshot/measurement pairs in
an isolated localhost preview: wide dark concurrent work, approval priority,
and narrow light reduced motion. Checks covered inactive session navigation,
stopping both occurrences, error state, stable long-title geometry, independent
Recents ordering and a running session outside both initial caps. The proof
used six sample catalogue reads, three synthetic job reads and eleven explicit
synthetic events; there were zero model sends, cancellations, approval decisions
or native mutations. Historical captures were retained; five old proof clicks
were scoped to Projects because conversation names now intentionally repeat.

Workspace typecheck, lint and tests passed, alongside the desktop production
build, docs conformance and external-name audit. Production CSP and the exclusion
of development sample fixtures remain intact. The live preview stays running;
no remote push, publication or live job modification was performed.

## Sidebar selection, expansion and blank conversation header

The user's follow-up screenshots identified four corrections. Project headings
no longer display green connection dots; selecting a failed project still exposes
its existing error and Reconnect surface. Session activity and errors continue
to use the shared thread projection in both conversation lists.

The root records which list successfully opened the current session after the
navigation generation guard. Only that Projects or Recents presentation is
highlighted. Pending, failed and superseded opens cannot change this provenance.
Existing session sends retain it; a newly promoted blank conversation selects
Projects. Folder headings highlight only the blank project route.

Untouched project groups now default to collapsed. The accepted project route
expands its group, while Recents does not. Search catalogue reads update row data
without changing expansion state. This addresses the prior default-open groups
that appeared to expand when a palette read populated their unloaded indexes.
Explicit user expansion continues to drive the existing folder glyphs and motion.

Conversation-only header controls now mount when a session exists. Background
work and Changes are absent on the blank project composer. All blank navigation
paths close the details pane so the unmounted controls cannot leave it stranded.

Desktop typecheck, lint, all 47 tests, build and docs conformance passed for this
correction. The production CSP and exclusion of preview fixtures passed. The
scope is local renderer behaviour; these checks do not establish a new remote
publication or runtime feature.

`sidebar-selection-proof.mjs` passed in one isolated localhost preview with
three inspected screenshot/measurement pairs and `sidebar-selection-receipt.json`.
It covers initial closed groups, Search plus a catalogue refresh, the single
accepted selection in both lists, shared running indicators, pending/failed/stale
reads, blank-folder pane dismissal and narrow light reduced motion. All mutation
counters are zero; controlled history/provider reads and events are synthetic.
Historical captures were retained. The live server remains available and this
correction is committed locally without a remote push.
