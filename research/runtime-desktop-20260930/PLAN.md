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
- [ ] **B — Desktop design and current demand.** Pin T3 Code and ZCode sources;
  examine process ownership, IPC, persistence, composer, review, background work,
  sidebar and responsive layouts. Record applicable user requests and design
  decisions, including features already present in Namzu.
- [ ] **C — Shared host boundary.** Desktop composes the existing Namzu runtime
  through an explicit supported protocol. No renderer access to Node, credentials
  or arbitrary shell commands; no independent model/tool execution loop or copied
  conversation store. Sessions, cancellation and approval must identify their
  owner and survive UI navigation without sending work to another conversation.
- [ ] **D — Working desktop.** Native application shell, project selection,
  conversation list, streaming messages, stop, tool progress, approval questions,
  error recovery and background work visibility. Responsive layout and keyboard
  handling; provider selection reports actual runtime state. Real Namzu adapter
  plus deterministic fixture adapter for interface and integration tests.
- [ ] **E — Priority host gaps.** Implement safe scoped history retrieval and
  operator diagnosis/reload where the shared boundary supports them. Deferred
  bundles and memory indexing require explicit correctness/measurement evidence;
  do not introduce a cache that silently changes integrity guarantees.
- [ ] **F — Verification and delivery.** Relevant integration/process tests,
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
