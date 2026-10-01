# Integrated runtime and desktop verification — 2026-10-01

This closes the selected implementation in `IMPLEMENTATION-PLAN.md`. It is a
local source verification, not a remote CI, merge, npm release or complete Pal
product claim.

## Coherent source commits

- `6194bda9689ee999b8e789300dcaef23b82daf3b` — explicit retained-child
  conversation continuation, direct child composer and host provenance;
  bounded background output readiness; live tool starts/progress and safe
  consumer lifetime; AG-UI interrupt buffering and liveness integration.
- `c1d2c04136bf7e0bd1b644f35c5cc1d13a6c2101` — desktop draft/queue/navigation
  ownership and source-derived header, compact composer, attached approval,
  ordered tool receipts and breadcrumb typography. Independent native review
  also closed reused provider call IDs, composing Escape cancellation and
  narrow drawer accessibility mismatches.

The public runtime changes include their five Changesets declarations and
matching SDK/CLI/AG-UI documentation. Desktop remains a private package. No
package version or changelog was hand-edited.

## Final local gates

The [gate receipt](artifacts/final-integrated-gates.json) records all 48
successful local gates, commands, actual exit codes and log hashes on source
commit `c1d2c041`, tree `5584576fe1cf0f631f1526bdc001372c56a53942`.
The first six gates and the remaining 42 come from two invocations on that
unchanged source. The successful full workspace test gate reports:

| Package | Passing tests | Additional result |
| --- | ---: | --- |
| SDK | 9,644 | 858 files |
| CLI | 4,697 | 516 files; 5 existing skips |
| AG-UI | 189 | 8 files |
| Desktop | 22 | 4 files |
| Sandbox | 1,692 | 88 files; 3 existing skips |

The receipt also covers SDK process tests, coverage and floors, test presence,
workflow parity, references, external names, log rules, entry points, model
prices, Zen generation, both installer parsers, evals, publish metadata,
consumer install and its snapshot regressions, exported signature types,
OKF/docs fences, and publint for all 21 publishable packages.

### Environment retries

An initial whole-workspace invocation failed with `ENOSPC` during sandbox
filesystem tests. Closed, owned reference checkouts were compressed onto the
Windows volume and compared byte-for-byte and by metadata before their Linux
copies were removed. Both were later restored to their original paths and
compared again. Their reversible archive receipts are included in the gate
receipt; user repositories, sessions, scheduled jobs and credentials were
untouched.

The first retry selected an overlong temporary root, so seven existing peer
directory tests correctly encountered socket-path limits instead of the
short-path branch they expected. A short private Linux root passed all 16
peer-directory tests; the full workspace and remaining gates then passed.
Neither environment retry changed production code or weakened a check.
Consumer preview manifests, changelogs and Changesets were restored after the
gate; the source worktree was clean before this verification note was added.

## Native proof and typography

[Native child/readiness reproduction](NATIVE-IMPLEMENTATION.md) uses the
actual CLI/kernel and real held shell/server processes. It verifies queued
input at a provider-valid boundary, a fresh TaskId in the retained child
conversation, preserved original metadata/history and parent draft, truthful
host notices, a live output wait, continued HTTP server operation after its
turn, `/jobs` visibility and cleanup.

[Desktop UI audit](../runtime-desktop-20260930/UI-AUDIT.md) and its actual
Electron receipts verify source-state composition, approvals, real file diffs,
background output/stop, event order, drafts/queue, stale navigation/snapshots,
reload/reconnect, keyboard/IME, narrow layout and reduced motion. The final
private roots are `/tmp/namzu-native-smoke-imTs7C` and
`/var/tmp/namzu-desktop-continuity-awKjNT`.

Actual Chromium glyph fonts, declared family/weight/size/line spacing and
painted probes match the independently rendered original components. Header
labels are 14px/500/20px, sidebar title 14px/500/20px and project 12px/500/16px;
code is 13px. Both windows resolve Selawik sans and FreeMono code on this host.
The native platform stacks can correctly resolve other faces on macOS/Windows.
The earlier manually composed 12px header comparison is superseded, not counted
as final proof.

Provider/network transport is scripted in these native checks. They establish
application/runtime behavior and real OS processes, not a live account or
model compatibility claim. Native desktop proof covers Linux/WSLg.

## Explicit remaining product work

The selected child messaging, readiness and desktop correction are complete.
The separate Pal product remains planned as documented in
`../runtime-desktop-20260930/PALS-ARCHITECTURE.md`: stable identity/revisions,
deployment grants and leases, groups/optional lead, durable dependency and
join enforcement/recovery, and a verified external A2A binding. The existing
advertised protocol version does not establish wire conformance. Internal
owned-child messaging does not use external A2A.

Desktop is a usable private source preview. Windows/macOS installers, signing,
auto-update, native credential setup, attachments, embedded browsing and
remote hosts are not claimed shipped. One-shot process output readiness is
not a new recurring watcher or automatic model wakeup. Existing source polling,
CAS delivery and process ownership remain the external watcher foundation in
`WATCHERS-ARCHITECTURE.md`.
