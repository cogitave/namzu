---
'@namzu/sdk': patch
'@namzu/cli': patch
---

Refuse an unreadable or structurally invalid persistent-memory index instead
of treating it as an empty store.

`DiskMemoryStore` now validates every persisted index entry before publishing
it into the live projection. Invalid JSON, newer schema data, unrecognized or
duplicate memory IDs, wrong field types, unknown statuses and invalid
timestamps leave the original index byte-identical and make the operation
fail. Once the durable file is repaired, the same store instance may retry.

The CLI's memory tools inherit the fail-closed boundary, so `save_memory`
cannot overwrite an index the current SDK could not safely understand.
