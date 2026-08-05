---
'@namzu/sdk': patch
---

A concurrent fan-out no longer allocates more budget than the parent has.

`sendMessage` read the parent's remaining budget at the top and debited it after
`provisionSpawn` — putting the two halves of a read-modify-write on either side
of an await, with the only critical section in between. So siblings launched
from one assistant turn all read the same undebited number and each took a
fraction of it. Measured: **four concurrent children were handed 50 000 + 50 000
+ 50 000 + 50 000 from a pool of 100 000.**

`create_task`'s own description instructs exactly the shape that triggers it —
*"'fan out 8 specialists' is one assistant message with 8 create_task blocks"* —
so the documented usage was the reproduction.

The read, the refusal when an allocation floors to zero, and the debit now all
happen inside the per-parent spawn lock. That keeps the property the debit's
placement was chosen for — a spawn this call rejects burns no allocation — while
closing the race that placement opened. It was introduced by a correct fix to a
different bug: moving the debit after the provisioning put it outside the lock.

**Nothing pinned it**, and the reason is worth knowing if you write tests here:
the existing concurrency test builds a fresh context per call, so each spawn got
its own tracker — it measures width, not budget. The sequential tests pass
because a refund makes the arithmetic close. The regression test holds its
children open, because a settled child refunds and the refund restores a
plausible number; a test that measures after settle sees a healthy total and
reports nothing.
