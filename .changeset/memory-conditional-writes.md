---
'@namzu/sdk': minor
---

Built-in memory stores now offer opt-in revision-checked updates and deletion. Read an opaque token with `getVersionedRecord` or `read_memory`, then pass it to `updateIfRevision`, `deleteIfRevision`, `update_memory`, or `delete_memory`. A stale token reports a conflict without applying the change. Existing calls without a revision keep their last-writer-wins behavior; custom stores need to implement the full conditional interface to accept revisions.

When a tool-result guardrail rewrites text, it also replaces any separate model-visible content blocks with that rewritten text, so the original blocks cannot bypass redaction.
