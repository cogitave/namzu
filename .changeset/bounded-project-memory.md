---
"@namzu/sdk": major
"@namzu/cli": major
---

Make project memory usable across runs, corrections and compaction, with bounded automatic recall in the CLI.

SDK memory search now matches ranked Unicode terms in titles, summaries and bodies instead of metadata substrings. `search_memory` defaults to active records and 10 results, with limits restricted to 1–50; pass `status: "archived"` to inspect archived records or use the store API for an unbounded listing. Hosts relying on the previous matching algorithm should supply a custom `MemoryIndex` with their intended semantics. `buildMemoryTools` adds `update_memory` and destructive `delete_memory`; hosts that allow only selected tools should filter the returned roster explicitly.

Disk memory operations now coordinate through a per-store lock and refresh the index for each operation. Read access requires permission to create the lock. Stop older writers before upgrading a shared store. A stale lock left by a crash is reported with its path and requires owner inspection after stopping cooperating processes; the store does not silently steal it or promise a crash-atomic multi-file transaction. `lockTimeoutMs` controls acquisition wait time.

SDK hosts can opt into `createMemoryRecallStep` through `prepareStep`. Preparation receives the current operator message independently of compacted history, estimated context headroom and cancellation. Checkpoints preserve that intent without duplicating attachment bytes. Both shipped stores provide optional `getRecord` snapshots; custom stores can implement it for consistent status/body reads. Promotion records actual claims and their source, skips exact prior claim sets on a best-effort basis, and leaves archived matches archived. Pin removal and extraction no longer retain a stale final pin or discard negative user requirements.

CLI automatic recall is now on: each main-session model step can receive up to three active project records, within 6,000 characters and available estimated context headroom, with a one-second deadline. Set `"memory": { "recall": false }` in CLI configuration to retain explicit tool-only retrieval. This setting does not disable memory writes. `compaction.consolidate: true` now chooses consolidation instead of also running the default promoter; omitted or false retains promotion.

Curated CLI memory files over 1 MiB, malformed text, non-regular files and links escaping their scope are skipped with diagnostics rather than read or overwritten. Split oversized files and keep them inside their intended scope. Notes saved beyond the prompt cap now say that they were saved but excluded from the model's context.
