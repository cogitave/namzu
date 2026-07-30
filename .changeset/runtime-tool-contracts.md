---
'@namzu/sdk': patch
---

Remove the model-facing `cancel_task` coordinator tool from the default
blocking worker protocol. A supervisor learns a `create_task` id only after
that worker is terminal, and the old tool manufactured a successful
"cancelled" result even when the gateway silently ignored a missing or
terminal id. Host-owned run interruption remains available through the task
gateway.

Tighten the builtin `edit` contract so `insertLine` accepts only a
non-negative JSON integer or the exact string `"end"`. Headings, anchors,
numeric strings, `null`, and empty strings are rejected before execution;
schema-bypassing callers receive the same refusal. This prevents `null` and
empty values from being coerced to line `0` and silently inserting content at
the beginning of a file.
