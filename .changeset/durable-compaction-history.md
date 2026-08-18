---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Make manual compaction the conversation history used after the command, not only a transcript notice.

The CLI now sends the compaction summary on the next turn and restores the same compacted history through `/resume`. It waits for pending turn writes before atomically replacing the durable conversation projection, refuses to compact an active turn, and pauses input while the snapshot is owned. Expanded file mentions and image attachments also remain in later model requests instead of being rebuilt from their lossy transcript rows. `/clear` continues to clear only the visible transcript.

The SDK adds optional `SessionStore.replaceMessages` support to its memory and disk stores. The disk implementation keeps the physical message log append-only by writing one replacement record, then projects later reads from it. `isCompactionMessage` is now exported for hosts that restore summary rows in their own views.
