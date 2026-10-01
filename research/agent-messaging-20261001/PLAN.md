# Agent messaging investigation — 2026-10-01

Baseline: `308522a5fde0508428257c0a30d4a023d4ac5a62` on the owned
`feat/runtime-desktop-foundation` worktree. Main checkout remains untouched.

Operator request: test actual interactive message delivery in Claude and Namzu,
inspect cloned Codex/Pydantic AI/Hermes sources, and correct the architectural
foundation before introducing Pals. Distinguish internal communication from A2A.

- [x] Trace operator steering, next-turn queue, parent-to-child correction and
  child completion paths; identify acceptance versus model-visible delivery.
- [x] Record installed Claude TUI behavior with a bounded background child and
  an operator correction during work. Observe tool/turn boundaries and status.
- [x] Inspect pinned peer source for delivery, ownership and terminology.
- [x] Exercise Namzu's real TUI and runtime with equivalent cases, retaining
  receipts. Clearly separate live-provider observations from scripted transports.
- [x] Investigate the clarified cross-session requirement using two independent
  original TUI sessions. Separate parent-child authority from peer discovery,
  message routing, idle wake, process ownership and delivery receipts.
- [x] Fix reproduced defects and prove delivery/order/cancellation invariants.
  Document any public changes and add changesets if production packages change.
- [x] Record the Pal communication decision, remaining gaps and verification;
  commit coherent work locally. No remote writes are part of this investigation.

The operator explicitly authorized research, planning and implementing the
selected corrections autonomously, including cross-session communication.
Do not assume a discovered session is authorized merely because it is listed.

Test workspace: `/var/tmp/n-msg-o3250V`. Tests use their own sessions and files;
existing user conversations, scheduled jobs and account data remain untouched.
No inferred success from a queued message or a child agent's narrative.

## Implemented and observed

- Reused the already shipped SDK peer transport; added the missing CLI lifecycle,
  bounded inbox, discovery tools and `/peers` controls. No new daemon or A2A hop.
- Original Sonnet 5.5 TUI: parent/child correction and two independent peer
  terminals exchanging HELLO/ACK. Source comparison is pinned in `DECISION.md`.
- Two native Namzu processes using a scripted provider: busy acceptance, pending
  UI, delivery after an apparent final response, and idle reply wake. The actual
  socket transport and shipped renderer ran; live provider claims are excluded.
- The native test reproduced stale discovery readiness at conversation admission;
  publication now happens at the admission boundary.
- Queue UI calls parent/child corrections accepted/queued, rather than delivered.
- Operator and peer failure hold automatic work until explicit continuation.
- Focused checks: 45 CLI tests in four files passed after the last behavior edits.
  Full workspace gates are running; an old `serve` text assertion was updated.

## Remaining closure work

- [x] Observe peer failure and held pending mail in two native terminals.
- [x] Finish all local CI gates on the final implementation and retain receipts.
- [x] Save reproduction instructions and limits, then commit explicit paths.
Goal closure is recorded in the thread after the final verification commit.

Final native failure run: two fresh terminals, one receiver request while the
second peer message remained pending, three requests after explicit operator
continuation. The corrected screen has no stale queued peer row. All test
terminals exited normally. Concurrent host shutdown callers share one close
promise; its real socket regression passes.

All 48 local gates completed successfully; final proof and limits are in
`FINAL-AUDIT.md` and `artifacts/local-gates.json`. Final closure includes a
documentation recheck and clean-worktree check before updating the goal.
