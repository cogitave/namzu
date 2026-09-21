// The session log: one append-only, hash-chained JSONL file per session
// (`DiskSessionLog`, `InMemorySessionLog`, the chain, the fold, the lease).
// Filled by the SessionLog workstream; the public barrels already re-export
// this module, so what lands here is public without touching them again.
export {}
