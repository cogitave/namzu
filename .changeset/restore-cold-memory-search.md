---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Make the first structured-memory search after process startup see records that
were already persisted on disk.

`buildMemoryTools(store)` is a new store-authoritative composition whose
`search_memory` tool awaits the store's asynchronous `list()` boundary. This is
the default for lazy and disk-backed stores. The existing
`buildMemoryTools(store, index)` form remains index-authoritative and performs
no store read, preserving custom pre-populated or independently managed search
indexes.

The CLI now uses the store-authoritative form for both its main and delegated
agent registries, so a fresh session can recall prior run memories without an
unrelated read or write first warming the in-memory index.
