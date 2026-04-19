---
title: Session and Store Folders
description: Deep reference for session structure, workspaces, retention, stores, and persistence boundaries inside @namzu/sdk.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Session and Store Folders

The SDK separates long-lived structure from persistence implementation. That is why session modeling does not live inside `store/`, and why runtime lifecycle still needs `manager/` on top of both.

## 1. The Boundary That Matters

These three layers intentionally do different jobs:

| Layer | Owns |
| --- | --- |
| `session/` | Structural rules, hierarchy, lineage, workspace behavior, retention semantics |
| `store/` | Mutable persistence implementations |
| `manager/` | Runtime lifecycle around those structures and stores |

This boundary is one of the most important architectural choices in the SDK.

## 2. `session/`

`session/` models how tenants, projects, sessions, sub-sessions, workspaces, handoffs, summaries, migration, and retention behave.

### 2.1 Session Subfolders

| Folder | What it owns | Why it is separate |
| --- | --- | --- |
| `hierarchy/` | Tenant, project, session, actor, lineage, and sub-session relationships | Structure and lineage are richer than plain IDs |
| `workspace/` | Workspace refs, path builders, backend registry, worktree driver | Workspace isolation is a session-owned concern |
| `handoff/` | Single and broadcast handoff, capacity checks, versioning, handoff events | Handoff is a workflow domain, not just a message |
| `summary/` | Deliverables, summary refs, materialization | Session summarization needs its own lifecycle and outputs |
| `intervention/` | Intervention chains and previous-artifact validation | Human or system intervention has structural rules |
| `migration/` | Filesystem migration, ID-prefix migration, migration markers, migration errors | Compatibility work should stay isolated from the hot path |
| `retention/` | Archive backends, retention policy, archival manager, tombstone behavior | Long-tail lifecycle deserves a dedicated subsystem |
| `events/` | Session event types and schema versioning | Session events should not be scattered across unrelated folders |

### 2.2 Why `session/` Is Deep

This folder is deep because the SDK treats sessions as a first-class domain:

- work needs lineage
- sessions need ownership boundaries
- workspace isolation has real operational implications
- old sessions need retention and migration rules

If all of that were flattened into `store/`, the code would lose the distinction between "what a session means" and "how it is saved."

## 3. `workspace/` as a Good Example of the Pattern

`session/workspace/` is especially important because it shows the domain-first approach clearly:

- `ref.ts` defines workspace references
- `path-builder.ts` owns path conventions
- `registry.ts` owns backend lookup
- `driver.ts` and `git-worktree.ts` own actual workspace backend behavior

This is why workspace logic lives under `session/` instead of under a generic filesystem helper folder.

## 4. `store/`

`store/` contains concrete persistence implementations for active runtime data.

### 4.1 Store Subfolders

| Folder | Responsibility | Architectural meaning |
| --- | --- | --- |
| `run/` | Disk-backed run artifacts, messages, transcript, reports, checkpoints | Run persistence is file-oriented and append-friendly |
| `task/` | In-memory and disk-backed task storage with concurrency handling | Tasks are mutable workflow state |
| `memory/` | In-memory index, in-memory storage, durable memory storage | Memory splits retrieval index from stored content |
| `session/` | Session persistence, linkage, and message storage helpers | Persistence implementation for the session domain |
| `activity/` | Activity event storage | Lightweight activity capture stays isolated |
| `conversation/` | Compatibility conversation storage | Legacy compatibility is isolated instead of leaking everywhere |

### 4.2 Why Stores Stay Narrow

Stores should:

- read data
- write data
- maintain local invariants needed for persistence correctness

Stores should not:

- orchestrate provider calls
- decide runtime policy
- become the public definition surface for a domain

## 5. `gateway/`

`gateway/` currently provides the local task gateway that hands work into manager-owned lifecycle.

Why it is separate:

- it is an ingress boundary, not a generic persistence implementation
- it is not the core model loop either
- keeping it small now preserves a clean place for future task-ingress adapters

## 6. Practical Ownership Rules

Use these rules when placing work:

1. If you are defining lineage, retention, workspace, or handoff rules, it belongs in `session/`.
2. If you are implementing disk or memory persistence, it belongs in `store/`.
3. If you are coordinating runtime actions around those structures, it belongs in `manager/`.
4. If you are exposing task ingress or handoff into the runtime, `gateway/` is the likely boundary.

## Related

- [State and Persistence](./state-and-persistence.md)
- [Folder Reference](./folder-reference.md)
- [Pattern Language](./pattern-language.md)
- [Session Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/session/index.ts)
- [RunDiskStore](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/store/run/disk.ts)
