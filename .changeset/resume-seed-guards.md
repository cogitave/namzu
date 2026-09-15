---
"@namzu/sdk": patch
---

Tighten the resume seed's accounting and guards.

A `write` a `pre_tool_use` hook SKIPPED gets a non-error receipt — the hook
declined the call, nothing failed — and the ledger replay read that as a
successful write, restoring a fingerprint for a body that never reached the
disk. The next edit to that file was then refused for a drift the ledger had
invented. The skip is now recognised through the same function the executor
writes it with, and withdraws the path instead.

Three other corrections to the same pass. A read that withdraws a path no
longer counts toward the six-body bound, so a later mutation cannot evict a
path still holding a body. Attribution reads each call's `path` at most once
per seeding and not at all past about a megabyte of arguments; past that the
call is a mutation that can be placed nowhere, and the seeding establishes
nothing rather than carry a body it may have replaced. And `query`'s checkpoint
resume seeds from the repaired history plus whatever of an owned resume turn a
completed scan says already ran — a recovered `write` restores the body it put
there, an unknown outcome withdraws the path, and a call proved never started
is left out because it is about to execute. Previously the seed never saw that
turn, so an executed write inside it left the body it replaced standing as a
claim.

A seeding that throws no longer propagates out of a resume: it is logged at
debug and the run continues with the empty ledger it would otherwise have had.

No public surface changed. Hosts calling `seedObservationLedger` directly get
the corrected pass with no change to the call.
