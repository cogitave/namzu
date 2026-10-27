---
'@namzu/sdk': patch
---

In the `accept-edits` review mode a `write` call is no longer held back by the destructive flag the `write` tool always carries (its input cannot say whether the file exists), so it is approved like an `edit`, as `docs/sdk/review-policy.md` already described. A path outside the roots, a protected path or a rule's ask still reaches a person. A host that wants every write asked about in that mode should use the `prompt` mode.
