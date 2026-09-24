---
'@namzu/sdk': patch
---

A session whose last turn completed after using a tool could not take a third message: `namzu resume <id>` (or a still-running `exec`/TUI process) refused it with `Message history repeats tool-call id '…'; a signed assistant turn cannot be rewritten safely.` and the turn never reached a provider.

The cause: a completed turn's own settled `Turn.messages` — what a host is told it may cache and pass back into the next `query()` call as the prior conversation — is one message shorter than a fresh fold of the session log at the same point, because a turn that is not the session's first sheds every earlier project-instruction snapshot (`AGENTS.md`, `CLAUDE.md`, …) from its own working set before it ever reaches a provider, while the log keeps one durable record per turn that carried one. `query()` compared the two positionally and, on the first mismatch, kept the whole stale array and appended it after the correctly-folded history instead of just the new message — duplicating everything the two shared, including the earlier turn's own tool call.

A project-instruction snapshot is now ignored on both sides of that comparison, the same way a system message already was, so this positional mismatch cannot happen. Existing sessions on disk in this shape resume correctly with no changes needed. `resumeSession` also now refuses a checkpoint whose turn the session log already shows completed or failed, before claiming a lease under its id, instead of only inside `query()`'s own deeper (and still-correct) refusal.
