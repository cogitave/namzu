---
title: Session Hierarchy — Tenant / Project / Session / SubSession / Run
description: Introduce a tree-shaped ownership hierarchy with explicit handoff, workspace isolation, and structured summary references, replacing the flat Thread + Conversation model
date: 2026-04-16
status: proposed
related_packages: ["@namzu/sdk"]
related_patterns:
  - docs.local/architecture/patterns/namzu-sdk/session-hierarchy.md
  - docs.local/architecture/patterns/namzu-sdk/collaboration-primitives.md  # Task 0b, forthcoming
---

## Status

Proposed.

## Context

`@namzu/sdk@0.1.x` exposes a flat `Thread → Run` hierarchy. Messages live in `ConversationStore`, scoped by `ThreadId`. There is no first-class concept of:

- **Multiple humans** collaborating on the same long-running goal (no ownership, no handoff, no read-only history of prior owners).
- **Delegation** as a branch (sub-agents are inlined as tool-call results on the parent transcript).
- **Workspace isolation** for parallel agent work (every sibling shares the same directory).
- **Project-level shared data** (memory, vaults, knowledge bases, deliverables) across sessions.

This is acceptable for single-operator scripting but unworkable for the managed-agent platforms Namzu's consumers are building on top of the kernel. It also leaves the SDK strictly behind Anthropic Managed Agents on collaboration and well behind commodity developer tooling (git's branch + worktree + PR model) on audit and reproducibility.

## Decision

Replace the flat model with a five-level hierarchy: `Tenant → Project → Session → SubSession → Run`, where `SubSession` is recursive under `Session` and bounded by a configurable `maxDelegationDepth` (MVP default `4`). Ownership is modeled as a single `currentActor` per session with atomic handoff (no accept step), optimistic `ownerVersion` CAS, and permanent read-only access for previous owners. Multi-recipient handoff fans out into N sub-sessions, each with an **isolated `WorkspaceRef`** (git-worktree is the MVP reference backend; tmpfs and container follow in Phase 2). Completed sub-sessions stay `idle` forever; parents ingest a structured `SessionSummaryRef` rather than the full transcript. Intervention on past output creates a new sibling sub-session with `prevArtifactRef`, never reopens. Project-level shared data (`sharedMemoryStores`, `sharedVaults`, `sharedKnowledgeBases`, `sharedDeliverables`) is opt-in per project — all four ship in MVP. Event subscriptions accept a subscribe-time `depth: 'self' | 'tree'` filter. `ConversationStore` is refactored to `SessionStore`; `ThreadId` is renamed `ProjectId` with a one-version compatibility alias. Full design detail lives in the pattern doc referenced above.

## Consequences

### Breaking impacts (top 3)

1. **`ConversationStore` → `SessionStore` with new on-disk layout.** `ThreadId` becomes `ProjectId`; messages are now scoped to `SessionId` rather than `ThreadId`. A one-shot migration script (`pnpm --filter @namzu/sdk migrate:0.2`) moves legacy `conversations/{id}/messages.json` under `sessions/{id}/messages.json` and wraps each historical thread in a synthetic Project. A one-version compatibility shim exposes `ThreadId` as an alias and logs a deprecation warning once per process; the shim is removed in 0.3.0. Additionally: a **boot-time filesystem re-layout** (`§13.4.1` of the pattern doc) rewrites legacy `.namzu/threads/` into `.namzu/projects/{prj_*}/sessions/_legacy_default/runs/` on first `RunContextFactory.build()` when the legacy path is detected. And an **ID-prefix migration window** (`§13.3.1`): 0.2.x readers accept both `thd_*` and `prj_*`; 0.3.x rejects `thd_*` — users must run `namzu sdk migrate-ids` before upgrading.
2. **`TenantId` becomes compile-time required across the kernel.** Every `Session`, `SubSession`, `Run`, `WorkspaceRef`, `HandoffAssignment`, `InvocationState`, `Task`, `AgentTaskContext`, `RunMetadata`, `RunPersistence` constructor, and `ConversationMessage` key tuple carries `tenantId`. Cross-tenant calls are hard errors (Convention #17). Missing `tenantId` at any of the call-sites enumerated in the pattern doc's `§12.1 Required-Callsite Matrix` is a compile-time error in 0.2.0 — not a runtime warning.
3. **Delegation surface changes, now fully kernel-governed.** Agent spawning creates a `SubSession` + `Session` + `WorkspaceRef` triple, not an inline tool result. The parent's context receives a `SessionSummaryRef` instead of a full child transcript — and that summary is emitted by `SessionSummaryMaterializer` as a **kernel terminalization primitive** (no `finalize_delegation` tool exists; agent emission would be a Convention #0 breach). Consumers who expected to read the child's raw messages from the parent run state must migrate to `SessionStore.drill(sessionId)`; the child transcript remains on disk but is no longer auto-inlined. Multi-recipient handoff is a **single transaction boundary** — partial fan-out is impossible by contract; on any failure the kernel emits `broadcast.rollback` and restores source-session state.

### New invariants introduced in this revision

- **Failed Sessions are not dead.** `run.failed → Session.failed` retains `currentActor`; retry opens a new Run; handoff from `failed` is allowed (target receives `contextDigest`). `run.cancelled → Session.idle` (same actor may retry).
- **`active → locked` transition illegal** while a Run is `running`/`awaiting_hitl`/`awaiting_subsession` — rejected with `HandoffLockRejected`.
- **`prevArtifactRef` is an acyclic DAG** bounded by `Project.config.maxInterventionDepth` (default 10). Cycle writes reject with `ArtifactRefCycleError`; depth overflow rejects with `InterventionDepthExceeded`.
- **Delegation is bounded on both axes.** `Project.config.maxDelegationDepth` (default 4) and `maxDelegationWidth` (default 8). Violation rejects with `DelegationCapacityExceeded`.
- **Shared-store writes are CAS-guarded** on `version`; conflicts surface `SharedStoreConflictError` (no auto-retry).
- **Sub-sessions archive, not close.** Explicit `RetentionPolicy` + `archive()` API + tombstones (`§12.3`). Worktree disposal happens at archival time, not on `idle`.
- **Every `RunEvent` carries `schemaVersion` (≥ 2 in 0.2.0) + `lineage` (for sub-session events).** Consumers use an envelope / additive-fields strategy; `RunMetadata.threadId` is mirrored by `projectId` for one version, removed in 0.3.0.
- **Event bus is tree-scoped.** One logical append-only log per root session; subscribers filter by `depth: 'self' | 'tree'`; monotonic `(rootSessionId, eventId)` ordering.
- **`RunStatus` gains `awaiting_hitl_resolution`** for persisted HITL timeouts under `HITLConfig.onTimeout = 'pause_run_until_resolved'` (see permission-policies.md §13.3); requires paired consumer-handling updates at the three exhaustiveness sites (§13.6). `SessionStatus` gains a matching `awaiting_hitl` reflecting any Run in `awaiting_hitl` or `awaiting_hitl_resolution`. `ActorRef` agent variant: `spawnedBy` renamed to `parentActor` — pre-0.2.0 design phase, no shim; downstream consumers update field references in the same PR.
- **`SubSessionStatus` enumerates the merge state machine** (`pending_merge → merging → merged | merge_conflict | merge_rejected`, `awaiting_merge`, `archived`); previously only in sibling docs. Pattern §4.4 / §4.4.1; paired exhaustiveness (§13.6).

### Non-breaking impacts

- Run-internal layout (`run.json`, `messages.json`, `transcript.jsonl`, `checkpoints/`) is unchanged.
- Existing `RunPersistence` semantics are preserved; it now resolves `sessionId` as its scope parent (previously `threadId`).
- New event types and fields are additive. Existing subscribers on Run events continue to work unchanged; the new `depth` parameter is optional (default `'self'` preserves prior behavior).

## Links

- Pattern doc (authoritative detail): [docs.local/architecture/patterns/namzu-sdk/session-hierarchy.md](../../../docs.local/architecture/patterns/namzu-sdk/session-hierarchy.md)
- Sibling doc for `merge_back` (Task 0b): `docs.local/architecture/patterns/namzu-sdk/collaboration-primitives.md`
- Conventions referenced: #0, #1, #2, #4, #5, #6, #9, #16, #17, #19 — see `docs.local/CONVENTIONS.md`.
