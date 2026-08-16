---
'@namzu/sdk': patch
---

Internal: adds `store/kv/DiskRecordStore` and adopts it in `DiskMemoryStore`. No public API change — the primitive is deliberately not exported, because it is a shape four call sites already agree on rather than a contract offered to hosts, and exporting it would freeze an argument list nobody outside has asked for.

Four disk stores each carried a private copy of the same twenty lines: `readFile` + `JSON.parse` + `migrate` with ENOENT collapsed to null, an atomic write of stamped JSON, and a `readdir` filtered by prefix. The properties they duplicated are not the obvious ones — a missing file is an empty read rather than an error, a record from a *newer* build is refused rather than read partially and written back with the difference gone, a listing needs an explicit sort because `readdir` order is filesystem-dependent. Every copy had to remember all of them, and a fix in one was a fix in one.
