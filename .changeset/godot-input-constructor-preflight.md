---
"@namzu/cli": patch
---

Check complete Godot input batches before the original MCP handler and runtime
WebSocket send. Invalid nested boolean strings previously aborted the pinned
runtime coroutine and could leave earlier input dispatched without a final
reply. Return a field-specific, repairable `not_dispatched` error instead,
without coercing values or sending any event from the refused batch.

Advertise the accepted boolean/number constructor types separately for each
input event in live tool listings. Use literal `pressed: false` to release a
key, mouse button or action; action `strength: 0` does not release it. Retain
open dictionaries and encoded top-level event compatibility without adding
required fields or injected defaults, and keep all other tools unchanged.

Preserve valid Godot constructor inputs, optional defaults, top-level server
coercion and ignored application dictionary keys. The generic SDK dictionary
schema remains unchanged. Existing unknown application effects still require
computer stop; validation never clears that barrier or replays input.
