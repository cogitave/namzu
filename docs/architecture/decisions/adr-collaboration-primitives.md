---
title: Collaboration Primitives — SharedPlan, WorktreeDeltaIndex, MergeOrchestrator
description: Three root-cause primitives for multi-user agent collaboration on a single Namzu project — plan-time prevention, execution-time awareness, and LLM-mediated HITL-gated merge resolution, all built on the real permission-policies v4 PolicyEvaluator with no adapter. v3 corrects the ActionRef format, registerAction-not-registerNamespace for core `merge` namespace, SubSessionStatus cross-link (v4 §4.4.1), `prevArtifactRef: DeliverableRef` typing, bounded quiescence, blocking drift reconciliation, `customPatch` base-hash proof-of-read, content-hash `HunkId`, config-load-time capability validation, and `PlanStep.description` write-path sanitization.
date: 2026-04-16
status: proposed
related_packages: ["@namzu/sdk"]
depends_on:
  - session-hierarchy (v3)
  - permission-policies (v4)
pattern_doc: docs.local/architecture/patterns/namzu-sdk/collaboration-primitives.md
---

## Context

Namzu's session hierarchy (see `session-hierarchy.md` v3) gives each user an isolated sub-session worktree under a shared parent session. Isolation alone, however, produces an unresolved end-state: N sub-sessions each with independent changes, no protocol for landing them back into the parent, and no mechanism for surfacing conflicts before they become last-write-wins incidents.

Existing collaborative-agent products solve this poorly. Single-user agent tools (Cursor, Copilot, Claude Code) lack the concurrent-sessions-on-one-project model at all — collaboration is out of scope. Cloud "team agent" products centralize through a server with implicit clobber semantics; conflicts surface late or silently. Git forges solve *textual* merge but model no agents, no sessions, and no plan-time prevention — they are strictly review-time tools. None of these puts the human in the right loop at the right time.

Separately, the permission engine defined in `permission-policies.md` v4 (Task 4) introduces a declarative, inheritance-resolved, deny-by-default policy system — `PolicyEvaluator.evaluate(actionRef, ctx) → PermissionDecision`. Per Convention #0 (no workarounds; fix at the root cause), the collaboration layer MUST use that system and MUST NOT reinvent a parallel gate mechanism.

The v4 API has now converged and is approved. A prior v1 of this ADR proposed a temporary adapter to let merge land before Task 4 was ready; that proposal was rejected on Convention #0 grounds. This v2 codes directly against the real API. There is no adapter, no bridge, no placeholder.

## Decision

Introduce three first-class primitives in `packages/sdk/src/collab/`, one per lifecycle stage of collaborative work:

1. **`SharedPlan`** — plan-time coordination surface. Default-ON for multi-recipient handoffs with deduplicated recipient count > 1 (configurable). Claim-based assignment with optimistic-version rejection via typed `PlanClaimConflict`. Cycle-rejected dependency DAG (`PlanDependencyCycleError`). Cross-project scope invariant (`PlanParticipantScopeError`). Per-step and per-plan CAS versions.

2. **`WorktreeDeltaIndex`** — execution-time awareness. Per-worktree live delta map with a git-diff reference backend and a pluggable `WorktreeDeltaBackend` interface (7 mandatory operations, conformance-suite-enforced). Provides `predictConflict(source, targets[], opts?) → ConflictReport` with a mandatory quiescence barrier (`flushPendingDebounces`) before reading delta. Syntactic-only heuristic disclosed explicitly via `falseNegativeWarning: boolean` for cross-file semantic conflicts. Debounced, never on the agent's critical path.

3. **`MergeOrchestrator`** — review-time resolution. `merge` is a core kernel namespace (permission-policies v4 §5.1); the orchestrator uses `ToolPermissionRegistry.registerAction` at module load for two actions only: `merge.apply` (`always_ask`) and `merge.rollback` (`always_ask`). No `registerNamespace` (core namespaces bypass allow-list/`ownerPluginId`). No `merge.review` action — preview uses `PolicyEvaluator.previewPolicy({ namespace: 'merge', name: 'merge.apply' }, ctx)`. `ActionRef.name` uses the dot-qualified form per v4 §4.1. Minimum-model capability gate validated at `MergeOrchestrator.init(config, modelProvider)` time (default `'advanced_reasoning'`) via `ModelProvider.capabilities`. Uses an LLM to produce a `MergePlan` with self-assessed confidence and a first-class `refuse` primitive (plan-level and per-hunk). Prompt hygiene — all inputs in `<tagged_blocks>`, `PlanStep.description` sanitized at write path (length ≤ 500, strip control + zero-width + RTL, escape tag glyphs); no raw transcripts unless opt-in. HITL via `PolicyEvaluator.evaluate` with `OnTimeoutPolicy: 'pause_run_until_resolved'` and durable `PendingHITLStore`. Bounded quiescence barrier (`quiescenceTimeoutMs`, default 5000ms) — timeout denies merge rather than wedging. Pre-apply drift reconciliation is **blocking** when `PlanStep.targetFiles` declared. Per-hunk resolver contract fully specified (`HunkResolutionRequest`/`HunkResolutionResponse`); `customPatch` requires `baseHash` proof-of-read — stale hash = rejection, not corruption. `HunkId` is content-hash derived for stability across upstream line shifts. Rollback is a new revert-intervention sub-session with `prevArtifactRef: DeliverableRef` (`session_summary` variant wrapping the pre-merge `SessionSummaryRef`) — merges are irreversible at the commit layer by design. MergeOrchestrator drives but does not own `SubSessionStatus`; the merge-back state machine lives in session-hierarchy v4 §4.4.1 SubSessionStatus.

Full technical detail — entity models, quiescence barrier, conformance suite, event schema, module structure, configuration — lives in `docs.local/architecture/patterns/namzu-sdk/collaboration-primitives.md`.

## Consequences

### Positive

- **Root-cause HITL.** All human gating for merge runs through the single permission engine. No parallel flag, no orchestrator-private confirm. Convention #0 satisfied.
- **Three-layer defense-in-depth.** Plan prevents, awareness surfaces, review resolves. Each layer is disable-able independently without breaking the others — operators opt-down per config knob.
- **Observable by construction.** Every primitive emits typed `RunEvent` variants that bubble via session-tree tree-scoped monotonic ordering (v3 §10.3). External UIs and audit logs get full visibility without new infrastructure.
- **Backend-pluggable.** `WorktreeDeltaBackend` is an interface (Convention #10); git is reference, but non-git backends (LSP, vector, object-store) can be added and must pass the 7-op conformance suite.
- **Honest quiescence.** `predictConflict` always flushes pending debounces before reading — no stale delta gets into a merge decision. The orchestrator ignores `requireQuiescenceBarrier: false` even when the flag is set at project level.
- **Honest false-negative disclosure.** `ConflictReport.falseNegativeWarning` tells the operator when cross-file semantic conflicts may exist below the syntactic index's detection threshold.
- **First-class LLM refusal.** `overallOutcome: 'refuse'` and per-hunk `strategy: 'refuse'` let the model decline when it lacks information. Confident-but-wrong plans are strictly worse than honest refusals; the kernel rewards the latter.
- **Audit-trail integrity.** Merges are irreversible at the commit layer; rollback is a new revert-intervention sub-session. No mutating history, no revisionist audit.
- **Merge-state machine lives in session-hierarchy v4 §4.4.1 SubSessionStatus.** Cross-doc absorption complete — the enum definition, merge-state transitions, and the session-status fan-in all live in the session-hierarchy pattern. MergeOrchestrator drives via `SessionStore.setStatus(...)`; the state field is owned by the session layer, not the orchestrator.
- **Drift reconciliation is pre-apply blocking when `PlanStep.targetFiles` declared.** Advisory `plan_drift_detected` at index time; blocking `merge_drift_detected` + typed `MergeDriftUnreconciledError` at merge time. Steps that left `targetFiles` undefined skip the blocking check — declaration is the opt-in contract.
- **`customPatch` requires `baseHash` proof-of-read.** Resolvers MUST compute `sha256(currentTargetContent)` before submitting; stale hash triggers `CustomPatchBaseHashMismatch` rather than corrupting the target file. Stale base = rejection, not corruption.
- **Bounded quiescence barrier.** `quiescenceTimeoutMs` (default 5000ms) prevents a hot sibling from stalling merge indefinitely. Timeout emits `merge_quiescence_timeout` and denies the merge — never silently merges stale delta.
- **Config-load-time capability validation.** `MergeOrchestrator.init(config, modelProvider)` validates `ModelProvider.capabilities.has(config.minModelCapability)`; mismatch throws `MergeOrchestratorConfigInvalid` at project boot. The runtime `merge_model_capability_insufficient` event remains as a belt-and-braces guard for mid-project provider swaps (BYOK rotation) only.
- **`HunkId` is content-hash stable.** Derived from `sha256(sessionId | path | startLine | endLine | contentBefore | contentAfter)` — stable across upstream line shifts that do not touch the hunk itself, so HITL resolvers / audit trails / dashboards track the same referent across reindex cycles.
- **`PlanStep.description` sanitized at SharedPlan write path.** Length ≤ 500; control + zero-width + RTL-override stripped; tag glyphs escaped. Merge consumers read already-safe text — tagged-block delimitation alone is not relied on as the sole prompt-injection defense.

### Negative / Costs

- **Top-3 breaking impacts (v3):**
  1. **`merge` is a kernel core namespace; MergeOrchestrator uses `registerAction`, NOT `registerNamespace`.** The prior v2 instructions to pass `ownerPluginId: '@namzu/sdk:core'` were incorrect — core namespaces are pre-registered by the kernel and do not flow through the allow-list. The canonical `ActionRef.name` format is the dot-qualified form (`merge.apply`, `merge.rollback`), per permission-policies v4 §4.1 — the bare-name form (`apply`, `rollback`, `review`) used in v2 examples is non-canonical and breaks the import contract. `merge.review` is removed entirely; preview uses `PolicyEvaluator.previewPolicy(merge.apply)`.
  2. **Merge state machine lives in session-hierarchy v4 §4.4.1 SubSessionStatus, not in MergeOrchestrator.** (Corrected from v2's `§5.2` cross-link, which is RunStatus, not SubSessionStatus.) Any prior integration code that modeled `SubSessionStatus.merging | merged | merge_conflict | merge_rejected` transitions inside the orchestrator must move the state-field ownership to the session layer's `SessionStore` and treat MergeOrchestrator as a driver only (emits transition events, calls `setStatus(...)`).
  3. **`bypassPermissions` explicitly does NOT modulate `merge.*`.** Operators relying on bypass mode to auto-merge in CI must change expectations: set tenant-level `merge.apply` override to `always_allow` via `registerSpecific(...)` for the CI tenant. Bypass modulates `tool.*` only.

- **Hard dependency on permission-policies v4.** The orchestrator's `evaluator.evaluate`, `PendingHITLStore`, and `OnTimeoutPolicy: 'pause_run_until_resolved'` imports resolve only once the permission engine is landed. No adapter path exists.
- **Hard dependency on session-hierarchy v3.** `ActorRef`, `RunStatus.awaiting_hitl_resolution`, `SubSessionStatus`, `SessionStore.deriveStatus`, tree-scoped event ordering — all imported directly.
- **Event surface expansion.** 16+ new `RunEvent` variants. Consumers must handle (or opt-in exhaustiveness-assert through) all of them at the four consumer sites documented in v3 §13.6 and v4 §16.
- **Config surface expansion.** New `ProjectConfig.collaboration` subsection — schema, validation, migration story for existing projects (default to safe values).
- **Git-shell-out cost.** Reference delta backend spawns `git diff` processes. Debouncing keeps it off the critical path but adds OS-level churn on large worktrees. LSP backend is a mitigation, not a same-milestone deliverable.
- **No in-place rollback primitive.** Operators who expected an "undo merge" button must adopt the revert-intervention sub-session flow — more surface, but also no history rewrite.

### Neutral

- **Opt-in default for SharedPlan.** Single-user handoffs do not create a plan; this is deliberate friction reduction but means solo users never exercise the plan machinery.
- **Minimum-model capability gate.** Default `'advanced_reasoning'` rejects sub-spec LLMs. Operators running cost-optimized small models for `tool.*` work must upgrade the merge-scope model provider or lower the gate.
- **Transcript inclusion is opt-in.** Operators debugging a failed merge may toggle `includeTranscripts: true` temporarily; an audit event records each inclusion.

## Alternatives Considered

### Adapter/bridge pattern (v1 — rejected)

v1 of this ADR proposed a temporary adapter matching the planned `ToolPermissionPolicy.resolve` signature so MergeOrchestrator could land before Task 4. Rejected on Convention #0 grounds: "temporary" permission-layer shims become permanent, silently drift from the real API, and make Convention #0 audit-impossible. The correct dependency order is: land permission-policies v4 first, then MergeOrchestrator imports directly. v2 codes against the real API with no intermediary.

### In-place rollback primitive

Considered. Rejected because history rewrite breaks session-hierarchy v3 §4.5 `prevArtifactRef` acyclic-DAG invariants and makes audit trails revisionist. A new revert-intervention sub-session is the correct primitive — ugly once, clean forever.

### CRDT-backed SharedPlan

Considered. Deferred to Phase 2. Current realistic plan churn is low; CAS + `PlanClaimConflict` handles it without the complexity budget a CRDT requires.

### Single-primitive merge (skip SharedPlan + DeltaIndex)

Considered. Rejected because it collapses the three distinct problem phases into one lossy step — exactly the failure mode the three-primitive design exists to fix.

## Link to Pattern Doc

Full technical spec: [`docs.local/architecture/patterns/namzu-sdk/collaboration-primitives.md`](../../../docs.local/architecture/patterns/namzu-sdk/collaboration-primitives.md).
