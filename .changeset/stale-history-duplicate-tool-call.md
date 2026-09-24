---
'@namzu/sdk': minor
---

A session whose last turn completed after using a tool could not take a third message: `namzu resume <id>` (or a still-running `exec`/TUI process) refused it with `Message history repeats tool-call id '…'; a signed assistant turn cannot be rewritten safely.` and the turn never reached a provider. An independent review then found the first fix was itself a partial patch: a host that edited an earlier cached message, or cached only a recent suffix of the conversation, still hit the same crash, and a caller-added system message that the log had never recorded could be silently dropped instead of reaching the provider.

The root cause of all of these was the same: `query()` reconciled a caller's cached prior messages against a fresh fold of the session log by comparing the two arrays **positionally**. Any place the two diverged — a project-instruction snapshot collapsed out of a turn's own settled messages, an edited message, a shorter cached suffix — broke the comparison for everything after it, either duplicating shared history (including tool calls `validateToolCallIds` then correctly refused as unsafe) or dropping something that was never durable.

Reconciliation is now by **id**, not position. Every message a host is handed back — `Turn.messages`, the messages `onConversationMessages` reports, a checkpoint's restored messages — now carries the id of the durable `message` record it came from (`BaseMessage.id`, a new optional field the kernel alone sets; never send one yourself). A host's next `messages` reconciles against the log's own history of every id it ever recorded, not only the current fold:

- a message with **no id** is new input and is kept, unless it exactly matches the next unclaimed message of the log's own fold by value, in which case it is that message read back and is dropped — this also covers a host that never adopted `.id` at all, which still reconciles by value against the whole fold, as it always has;
- a message carrying an id the log recorded, **unedited**, is already durable and is dropped — including one from before a compaction that has since summarized it away, since the log remembers every id it ever gave out, not only the current fold;
- a message carrying an id, **edited** before being resent, now fails the turn with a new `stale_cached_history` error (`details.kind: 'edited'`) instead of crashing or silently corrupting history;
- a message carrying an id **this log never recorded** (a host that minted its own, or copied one over from a different session) fails the same way (`details.kind: 'foreign'`).

Both `stale_cached_history` cases name the message id and fail closed before any provider call — never concatenate a caller's stale cache after the log's own fold. The way out for a host that hits either is to pass only its new messages (no id), or to re-read history from the session instead of reusing a cached copy. A host that only ever resends exactly what it was given back needs no change and sees no new error.

`resumeSession` also refuses a checkpoint whose turn the session log already shows completed or failed, before claiming a lease under its id, instead of only inside `query()`'s own deeper (and still-correct) refusal.
