---
type: Reference
title: namzu drain
description: One bounded pass that continues the parked turns another process left behind — how it finds them, takes each session's lease, what it refuses to resume past, its flags and its exit codes.
resource: packages/cli/src/commands/drain.ts
tags: [cli, headless, durability, sessions]
status: stable
generated: { by: process:claude-code, at: 2026-09-21T00:00:00Z }
---

# `namzu drain`

A turn can park in one process — waiting on a provider that rate-limited it,
or on a decision a person has to make — and be continued in another.
`namzu drain` is the command that does the continuing. It finds the parked
turns under the scope you name, takes each session's lease, continues the
**same turn** from its checkpoint, and gives the lease back.

**It is not a daemon.** `namzu serve` still says namzu has no daemon, and this
command is the reason that holds: one bounded pass, an exit code that says what
happened, and whatever you already use to run things periodically runs it
again.

```bash
namzu drain --store ~/.namzu --tenant <id> --project <id> --session <id>
```

## How a pass works

1. **Find.** The pending decisions and parked turns come from the session
   index (`SessionIndex.listPendingDecisions`), which is derived from the
   session logs, so a turn another process parked is visible as soon as its
   records are written.
2. **Take.** For each session, the drain claims the session's lease
   (`claimSession`) under the holder name it was given. A session whose lease
   another worker holds is **skipped** and reported as held by others; it is
   never resumed twice. A lease expires, so a worker that died does not hold a
   session for good.
3. **Continue.** It resumes the turn with `resumeSession`: the same session,
   the same turn id, from the checkpoint the turn parked at. Every record the
   resumed turn appends carries the lease's fence, so a drainer that stalls
   past its lease cannot write into a session somebody else has since taken
   over.
4. **Release.** It gives the lease back. One it could not release is reported:
   the work landed, but the session is unavailable to the next reader until
   the lease lapses.

A turn parked on a **human decision** is reported and never resumed past. The
answer belongs to a person; a drainer that continued without it would discard
the question the turn stopped to ask. A turn with no checkpoint to continue
from is reported separately, because the two mean opposite things.

A resumed turn keeps its root turn's token ledger: draining grants no fresh
allowance, and a configured `limits.tokenBudget` that differs from the one the
ledger was opened with is refused. Checkpoint recovery preserves unknown tool
outcomes instead of repeating an action without a recorded completion.

## Flags

| Flag | Meaning |
|---|---|
| `--store <dir>` | The application home whose sessions are drained (a `NAMZU_HOME`). Required: an empty queue and a directory nobody writes to would otherwise report the same thing. |
| `--tenant <id>` | Isolation boundary. Required; there is no default. |
| `--project <id>` | Required. |
| `--session <id>` | Required. |
| `--holder <id>` | Who is taking the sessions. Must be unique per process; defaults to one derived from the process id. |
| `--ttl <ms>` | Lease length (default 600000). |
| `--max-concurrent <n>` | Turns in flight at once (default 1). |
| `--cwd <path>` | Directory the resumed turns work in. |
| `--provider <id>`, `--model <id>` | Provider and model to continue with. |
| `--trust` | Accept this folder for this pass. |

Any other argument is refused rather than ignored: the command acts on other
processes' work, and a mistyped `--tenant` that fell through would drain a
scope nobody asked for.

## Output and exit codes

The pass prints one summary: turns listed, resumed, awaiting a decision,
with no checkpoint, held by others, already handled, failed, and leases not
released. Each failure and each unreleased lease is also named on stderr.

| Code | Meaning |
|---|---|
| 0 | Every turn it took was continued. |
| 1 | A turn failed or was cancelled after resuming, or the pass could not run: no provider, or state under `--store` that could not be read (an unreadable directory, an index that would not open). Entering the resumed loop alone does not count as success. |
| 64 | An argument was wrong, including a scope the store does not hold: a `--store` with no `projects/` directory, a session the index does not know, a session under another project or tenant, or a child session. |
| 77 | The folder has not been trusted. |

## Before upgrading from an older CLI

The drain of CLI 26.x and earlier read the per-run checkpoint layout, which
this version does not read. Run the old version's `namzu drain` until nothing
is parked before upgrading; a turn still parked afterwards cannot be resumed.
