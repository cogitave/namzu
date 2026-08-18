---
'@namzu/cli': minor
---

`/title` and `/fork`: name a conversation, and branch one

`/resume` listed every conversation by the first thing typed in it. That is a
reasonable default and a poor identity — it stops describing the work as soon as
the work moves on from its opening question, and two conversations that began
the same way are one row twice.

`/title <name>` fixes a name in place; bare `/title` reports the current one, and
`/title clear` goes back to the derived one. Bare `/title` deliberately asks
rather than clears: a name erased by an early enter is a loss nobody notices
until the next `/resume`. Named rows are shown in quotes, because a chosen name
keeps meaning what it meant and a derived one does not, and without the mark the
list reads as if every row were chosen.

`/fork` continues in a copy and leaves the original where it is: the transcript
on screen carries over, the next turn is written to the copy, and the original
is unchanged and still resumable. The copy is a real session with the transcript
written into it rather than a pointer, so the two diverge from the fork point.

It is always named — `… (fork)`, then `… (fork 2)` — and that is load-bearing
rather than cosmetic: a fork and its original share every message they have, so
both derive the same title, and `/resume` would show two rows a person cannot
tell apart in the list they would use to undo the fork.

`/fork` is refused while a turn is running. Interrupting the way `/resume` does
would be wrong here: `/resume` leaves a conversation, so an interrupted reply
landing in the one being left belongs there — a fork stays, and the copy would
be missing the last thing the operator watched arrive.

Names live in `.namzu/titles.json` beside the sessions rather than on the SDK's
`Session`: nothing in the kernel would read one, and putting it in the entity
would widen a store interface every host implements to carry a string only the
CLI writes and displays.

`RecentConversation` gains a `named: boolean`. A host rendering its own picker
should show the two kinds differently.
