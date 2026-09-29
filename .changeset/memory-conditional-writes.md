---
'@namzu/sdk': minor
---

Built-in memory stores now offer opt-in revision-checked updates and deletion. Read an opaque token with `getVersionedRecord` or `read_memory`, then pass it to `updateIfRevision`, `deleteIfRevision`, `update_memory`, or `delete_memory`. A stale token reports a conflict without applying the change. Existing calls without a revision keep their last-writer-wins behavior; custom stores need to implement the full conditional interface to accept revisions.

In-memory revisions cover cloneable BigInt, Map, Set, Date, cyclic metadata and the full backing buffers visible through typed-array views. Direct resizable `ArrayBuffer` values include their resize attributes. When metadata cannot be fingerprinted synchronously, including views backed by `SharedArrayBuffer` or resizable `ArrayBuffer`, `read_memory` still reads it but offers no revision; conditional writes fail closed.

When a tool-result guardrail rewrites text, it also replaces separate model-visible content blocks and the original failure error, so neither channel can bypass redaction.
