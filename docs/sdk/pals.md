---
type: Reference
title: Persistent Pals and computer admission
description: Saved Pal identities, immutable profile revisions, injected local computers and exclusive execution admission in the SDK.
resource: packages/sdk/src/pals
tags: [sdk, pals, identity, computers]
status: draft
---

# Persistent Pals and computer admission

A Pal has a saved identity across conversations: its name, purpose, selected
provider/model and current pause state. A Pal conversation pins one immutable
profile revision. These records belong to `@namzu/sdk`; the CLI and desktop are
hosts of the same API. A Pal is separate from a delegated child agent and does
not require a desktop application.

## Store

`DiskPalStore({ root, workspaceRoot, secureDirectory? })` implements `PalStore`.
Both paths are explicit; the SDK does not choose a global application home.
They must be separate real directories without symlink aliases or overlap.
`workspaceRoot` holds empty, uniquely allocated **host control directories**.
These directories identify conversation storage and outputs; they are not a
virtual computer, an execution filesystem or a security boundary.

The store exposes `create(PalCreate)`, `get(id)`, `list()`,
`getRevision(id, revision)` and `update(id, expectedRevision, PalUpdate)`.
`DiskPalStore.atWorkspace(cwd)` additionally resolves an exact owned control
directory. Reserved control-root descendants and aliases are refused; they
cannot fall through to ordinary host execution.

A `PalDefinition` contains `v: 1`, `kind: 'pal'`, a UUID `id`, `name`, `purpose`,
`workspace`, `model`, `paused`, `revision`, `createdAt` and `updatedAt`.
`model` is `{ provider, model }` or `null` for host defaults. It contains no
provider credential. `PalCreate` accepts name, optional purpose and optional
model; `PalUpdate` accepts name, purpose, model and paused. Multiline purposes
are retained.

Each successful edit publishes an exclusive next revision. Existing revision
files remain unchanged. Two editors using the same expected revision cannot
both publish it: the loser receives `PalConflictError` and must reload.
Definitions and host control directories survive process restart. The optional
`secureDirectory(path)` hook lets hosts enforce user-specific Windows ACLs;
the default sets owner-only permissions on POSIX systems.

## A required virtual computer

`PalRuntime({ store, environments? })` admits execution only through an injected
`PalEnvironmentProvider`. An absent provider refuses execution. A plain host
folder is never an execution fallback.

`PalEnvironmentProvider.acquire({ pal, conversationId, signal? })` returns a
`PalEnvironmentLease` with the same `palId`, an opaque `environmentId`, a
positive integer `generation`, a guest `Sandbox`, a guest `ComputerUseHost`
and `release()`. Screenshot, mouse and keyboard capabilities are required.
A guest `BrowserHost` is optional. The provider may expose `probe()` returning
`{ ready, reason? }`. The embedding host is responsible for a truthful provider;
capability flags alone do not prove a virtual-machine boundary.

The shipped [local computer provider](local-pal-computer.md) supplies a Linux
container desktop with persistent Pal storage through a preinstalled local
Docker engine. It does not mount the host control directory or inherit host
browser accounts. It shares the engine's kernel and is not a dedicated-kernel
VM. Provider credentials remain with the host's existing model routing.

## Ownership and lifecycle

`startComputer(palId, signal?)` starts or returns a warm computer.
`computer(palId)` returns its ready lease or null; `computerError(palId)` returns
an unavailable notice. `busy(palId)` reports an active controller, pending start
or pending stop.

`admit({ palId, revision?, conversationId, signal? })` returns `PalAdmission`:
its pinned `definition`, `lease`, `assertActive()` and `release()`.
One runtime allows one active controller for each Pal. Another conversation
receives an explicit busy refusal. The local provider also uses a deterministic
container name to refuse a second host process trying to own the same computer.
The SDK runtime's controller map is process-local; an embedding provider must
supply any required ownership across host processes.

The host must call `assertActive()` before every new guest file, shell, browser
or computer operation. It checks admission ownership, current pause state and
computer retirement. Pausing during computer startup cannot publish a usable
lease. A profile edit affects future conversations; a pinned revision remains
stable, while current pause state always applies.

`PalAdmission.release()` releases the task slot and keeps the computer warm.
`stopComputer(palId)` refuses active work and releases the guest only after the
provider confirms cleanup. `close()` revokes admissions and stops all owned
computers. A failed release remains tracked and unavailable; stopping or closing
can be retried. A retired sandbox requires an explicit confirmed stop before
replacement. No failed cleanup is reported as a stopped computer.

This API supplies identity and admission. It does not start a resident daemon,
create schedules, run Teams or expose host plugins automatically. Those hosts
must bind their own conversation logs and operations to the admitted Pal.
