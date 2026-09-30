# Runtime and desktop work — 2026-09-30

## Active objective

Implement the confirmed runtime corrections and begin a usable Namzu desktop
application, informed by fresh source comparisons and current operator requests.
Keep one kernel and durable session history, expose real execution and review
states, and verify the working flows rather than only producing screens.

User authorization: autonomous development and required local setup; no further
questions during the user's absence. Remote publication is not required for this
development objective. Existing live jobs and unrelated worktrees are outside it.

## Baseline

- Branch: `feat/runtime-desktop-foundation`.
- Base: `166cfd06`, including the verified schedule ownership work at `57c99b22`.
- Installed/buildable checkout: `namzu-wt-schedule-ownership`.
- Active goal: runtime corrections, peer comparisons, priority host improvements,
  and the first functional desktop slice, with durable evidence and commits.

## Sequence and acceptance

- [x] **A — Runtime correctness.** Failure fingerprints and progress-aware retries;
  real query regressions for repair/retry, differing errors, unchanged failure,
  unrelated read and denied mutation. Task snapshots use request-only context;
  actual provider-role tests cover ordinary send and compaction/resume boundaries.
- [x] **B — Desktop design and current demand.** Pin T3 Code and ZCode sources;
  examine process ownership, IPC, persistence, composer, review, background work,
  sidebar and responsive layouts. Record applicable user requests and design
  decisions, including features already present in Namzu.
- [x] **C — Shared host boundary.** Desktop composes the existing Namzu runtime
  through an explicit supported protocol. No renderer access to Node, credentials
  or arbitrary shell commands; no independent model/tool execution loop or copied
  conversation store. Sessions, cancellation and approval must identify their
  owner and survive UI navigation without sending work to another conversation.
- [x] **D — Working desktop.** Native application shell, project selection,
  conversation list, streaming messages, stop, tool progress, approval questions,
  error recovery and background work visibility. Responsive layout and keyboard
  handling; provider selection reports actual runtime state. Real Namzu adapter
  plus deterministic fixture adapter for interface and integration tests.
- [x] **E — Priority host gaps.** Implement safe scoped history retrieval and
  operator diagnosis/reload where the shared boundary supports them. Deferred
  bundles and memory indexing require explicit correctness/measurement evidence;
  do not introduce a cache that silently changes integrity guarantees.
- [x] **F — Verification and delivery.** Relevant integration/process tests,
  visual and keyboard checks, workspace/CI gates, build/launch smoke, coherent
  commits, current documentation/changesets and a precise record of platform
  coverage and remaining release work.

## Evidence and decisions

- Confirmed roots and replay scripts: `research/workflow-peers-20260930/`.
- Fresh desktop references: `pingdotgg/t3code` and `zai-org/ZCode`.
- Current Namzu issues #546/#550 involve provider switching and persistence on
  Windows; #547 concerns model discovery. Existing fixes must be checked before
  adding another routing mechanism.
- T3 Code's current issue list includes hidden attachment failures, task-state
  visibility, WSL cold-start, stale worktree execution and auth refresh. These
  inform acceptance cases; issue reports alone are not confirmed Namzu defects.
- ZCode has disabled GitHub issues; evaluate its source and documented workflows.

## Progress log

- Goal created and worktree verified. Both desktop source repositories cloned.
- Planning and implementation started on an isolated local branch in the existing
  authorized checkout. No external dependency setup ran in peer repositories.

- Runtime corrections verified: 19 SDK query regressions and 22 CLI context/provider
  tests pass; SDK/CLI typechecking, docs OKF, log and external-name gates pass.
  The original probes now show user-role task context and successful check after
  repair (`runtime-after.jsonl`). Full-tree gates will run after the desktop slice.
- Native desktop will be an Electron client of `namzu acp`, with opt-in scoped
  host extensions. The renderer receives typed UI actions, not arbitrary RPC.
  Source review found the CLI ACP gateway currently lacks `load`; restore it with
  project/tenant checks before offering conversation resume in the app.

- Desktop architecture and pinned peer comparison are recorded in `DESIGN.md`.
  Native protocol integration, scoped history/extension tests and initial UI are
  implemented. Native end-to-end verification is in progress; do not treat the
  first build as completed platform/release validation.

- Native Electron/CLI/kernel smoke passes real foreground and background shells,
  separate approvals, automatic next-turn queueing, output/stop, narrow layout
  and renderer Node isolation. Window reload preserves the live review and queue.
- Transport/ownership tests cover UTF-8 framing, process exit, malformed output,
  incompatible host rejection, cross-session review refusal and stop/queue
  semantics. Actual CLI tests cover scoped/archived history, display truncation,
  session-local routing and retaining fallback/delegation configuration.
- Priority retrieval is now exposed through scoped CLI history; connection reload
  and reconnect reuse the runtime/log. Incremental memory indexes and full deferred
  bundles remain evaluated follow-up designs, since the current file integrity and
  activation contracts cannot be weakened by a shortcut cache.
- The initial whole-tree validation completed 48 successful gates; native
  selected-model, queue/review, durable history and anonymous Zen receipts are
  recorded in `VERIFICATION.md`.
- The user rejected the initial independent visual design and prefers the main
  source reference. Rebuilt the renderer using its actual controls, palette,
  sidebar and composer, plus compatible message/error/group components from the
  other source. Mandatory attribution is separate from brand-neutral app code.
- Revised native coverage checks model-menu keyboard/focus, scoped choice,
  conversation-title search, appearance persistence and wide/narrow popovers.
  Final revision capture, checks and coherent commit are being completed.

- Operator requested the CLI wordmark and brand colours. Exact two-row lettering
  now appears in sidebar/welcome, with phosphor action/focus accents and quiet
  short panel/menu/message transitions. Native proof includes deterministic
  animation samples and reduced-motion behaviour.
- A full rerun exposed a foreign `.git` marker in shared `/tmp`; project identity
  correctly regarded temp siblings as one checkout. No isolation checks were
  weakened. An independent `TMPDIR` restored all 4,665 CLI tests (5 existing
  skips); the temporary diagnostic edit was removed.

- Final gate run found a skill-save screen assertion depending on whether a home
  path places `(suggested)` across a terminal wrap. Join the actual rendered rows
  before checking the marker; retain all content, save and cancellation checks.
  Five real overlay cases pass under the short independent temporary root.

- Revised first slice is complete: 48 actual repository gates pass, including
  the resumed missing-dash step and all later checks. Final root lint/typecheck
  plus desktop build, 13 tests and real native flow were refreshed. Both the
  baseline and revision receipts are retained. Coherent local delivery includes
  source provenance, operator identity, screenshots and explicit platform limits.

## Reopened visual acceptance — 2026-10-01

The user rejected the styling again. Functional gates remain valid for their
recorded commits; they do not establish visual acceptance.

- [x] Directly adapt the reference's composed sidebar cards, titlebar, timeline
  rows, composer body/footer/context strip and diff surface. Remove independent
  CSS overrides. Keep only the operator wordmark and phosphor brand tokens.
- [x] Render an isolated reference from the pinned source presentation components
  and CSS; compare equivalent content, viewport, theme and interaction states.
  This is a presentation reference, not an execution of the peer's full runtime.
- [x] Refresh native runtime, responsive, keyboard, motion and real file-diff
  verification; record evidence and commit the corrected slice.

The direct-composition revision passes all 48 local gate commands. Root lint and
typecheck, desktop build/lint and native/reference flows were refreshed after
the last renderer refinements. The real kernel write appears in Open diff;
selected source/local geometry and typography are independently compared.
Receipts are in `artifacts/direct-composition-gates.json` and
`artifacts/direct-composition-refresh.json`. This completes the local correction;
it is not a remote publication or a claim that all peer screens match.


## Operator question — recurring multi-provider teams

The CLI already launches local children on different providers/models and can
collect results and send corrections. `/loop` repeats in an open conversation.
A durable scheduled run pins one provider/model and constructs
`subagents: { active: [] }` in `schedule/fire/fire.ts`; it does not retain an
operator-defined multi-provider team. This is a verified remaining gap, not a
feature delivered by the desktop visual correction.

Follow-up design must define a stored mission/team, provider/model/tool/budget
policy per role, a coordinator and completion contract, and a scheduler snapshot
that retains those roles without silently widening unattended permissions.
Validate a recurring run using multiple real provider bindings, cancellation,
partial failure and restart recovery before claiming this workflow is ready.


### Recurring team research completed

See `RECURRING-MISSIONS.md`: pinned source review of Pydantic Graph/durability,
Temporal schedules/replay, Inngest step checkpointing and Hermes delegation/cron/
God mode model races. The proposal separates a saved definition, each cron
occurrence, a workflow run, logical node and execution attempt. It specifies
explicit DAG admission, typed artifacts, joins, per-role routes, overlap policy,
fenced persistence, uncertain effects and restart reconciliation. Existing
`workflow`/`phase` labels are display-only and TaskStore.claim does not enforce
prerequisites. This is researched future work, not a newly implemented feature.
The operator asked to complete the current work first and discuss this plan
before implementing the recurring-team architecture. No mission implementation
starts as part of this visual correction.
