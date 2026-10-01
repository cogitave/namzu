# Child conversation continuation and Pal readiness

Updated: 2026-10-01. Working branch: `feat/runtime-desktop-foundation`.
Baseline: `7f5f1284`. This is an implementation tracker, not a claim of release.

## Authorized implementation

- [x] Add an explicit SDK child-conversation continuation request. Keep the
  child SessionId; allocate a fresh TaskId, budget account, current parent
  authority and cancellation scope. Never reopen a terminal task.
- [x] Retain bounded, process-owned child definitions and conversation authority
  across parent turns. Saved transcript files alone never authorize execution.
- [x] Add a direct operator composer in the selected child transcript. Busy
  input queues at a provider-valid boundary; idle input starts a new invocation.
- [x] Give the parent a host-authored record of direct operator instructions,
  with acceptance distinct from consumption and child output distinct from
  operator authority.
- [x] Verify ownership changes, overlapping submissions, current permissions,
  budgets, cancellation, provider-valid tool results, history continuity and
  immutable original lineage with deterministic regressions.
- [x] Exercise the actual Namzu TUI and update public docs and changesets.
  Native child follow-up and persistent-server readiness receipts are recorded
  in `NATIVE-IMPLEMENTATION.md`; model transport is scripted.
- [ ] Finish all local CI gates and commit the coherent integrated result.

## Contract choices

Identity, conversation and task are separate. An existing child conversation
may receive another invocation only while this host retains its admission
authority. A running shell call is not interrupted by a queued message.
Follow-up admission reacquires current policy and credentials. Isolated
workspace reuse requires an explicit resource lease contract; it is refused
until that contract exists. Independent terminal peers continue to use their
separate transport. Workflow labels remain presentation, not dependency gates.

## Pal architecture and remaining product work

The decision in `../runtime-desktop-20260930/PALS-ARCHITECTURE.md` is selected;
the Pal product is not complete. These are separate deliverables:

| Deliverable | Current state | Prerequisite / acceptance |
| --- | --- | --- |
| Stable Pal identity and versioned definition | Planned | Host-owned registry; standalone invocation; revision pinning |
| Deployment, credentials and environment | Planned | Revocable grant references; fenced resource leases; cleanup |
| Groups and optional lead | Planned | Membership and role contracts; no implicit authority union |
| Durable workflow execution | Partial primitives | Enforced dependencies and joins; durable dispatch/recovery; one workflow run per cron occurrence |
| Local owned-child communication | Implemented locally; final gates pending | Direct composer; fresh invocation; parent provenance |
| Independent local sessions | Implemented locally | Same-project/current-mode admission; no crash durability claim |
| External A2A | Contract mismatch found | Select supported official binding; schema and SDK interoperability; authenticated task ownership and cancellation |

The existing A2A adapter's advertised 0.3.0 version does not prove conformance.
Changing its version string cannot repair the wire contract. Correct the
binding and verify it before exposing Pal endpoints. A2A is an external
interoperability boundary, not the internal child mailbox.

These choices follow established execution and authority contracts. There is
no single universal standard defining a Pal, group or lead. Product naming
must not hide missing lifecycle, resource or protocol guarantees.

## Additional authorized parallel work — 2026-10-01

- [x] Implement the researched background process readiness gap in
  `WATCHERS-ARCHITECTURE.md`: bounded literal output matching, unchanged exit
  default, clear match/exit/timeout/abort outcomes and current host ownership.
  Existing scheduled source polling and CAS delivery remain the chosen basis
  for external watchers; no duplicate WatcherAgent framework is required.
- [ ] Complete a concrete desktop usability slice using the existing source
  component composition and native audit harness; preserve Namzu identity,
  test actual interactions/responsiveness/motion and document platform limits.
  Track its exact implementation and native proof in the desktop research plan.

Both are part of the user's current eight-hour autonomous authorization. Local
implementation and verification proceed in parallel; remote-write approvals
remain specific to their own operations.

## Live tool event gap found during native readiness verification

- [x] Stream starts and progress while an approved tool batch is still running,
  using a pending-event notification rather than polling. The first native
  probe showed recorded tool starts arriving in the TUI only after a 120-second
  wait finished. This was a product event-stream defect, not a server failure.
- [x] Cancel and join the captured batch when the stream consumer returns early;
  otherwise the new live yield could release its recorder while execution ran.
- [x] Verify live starts/progress, reverse parallel completion, caller abort and
  consumer return with four deterministic actual-query regressions.
- [x] Repeat the actual PTY test: observe a split literal, run an HTTP check while
  the server remains alive, show it in `/jobs`, and stop it on host close.

Native receipts and reproduction are in `NATIVE-IMPLEMENTATION.md`. Completion
of the implementation checkboxes is not a release or a final full-CI claim.

## Integration defects fixed during final checks

- [x] Preserve direct-child notices when a parent stops before a model request.
  A deterministic actual-query timeout reproduced premature acknowledgement;
  only `end_turn` now acknowledges the exact captured context snapshot.
- [x] Keep AG-UI questions/frontend calls answerable with live tool events.
  Tool starts/progress no longer falsely expire a parked call, and resume cannot
  overwrite its unread event. All 176 original and 13 new package tests pass.

Full SDK unit suite (858 files / 9,644 tests), SDK process tests and SDK coverage
passed on frozen source. Whole-workspace integration and the reopened desktop
composition correction are still being completed; no remote write is claimed.
