---
'@namzu/sdk': patch
---

Four places where the runtime lost information it was holding, or admitted a limit it had already exceeded.

- **A clipped sandbox stream said nothing.** `SandboxExecResult` carries `stdoutTruncated` / `stderrTruncated`, added when the other backend needed to report a clipped stream. The local backend clipped at the same cap and never set them, so the model read a complete-looking result whose tail was gone — against the contract's own note that the kernel does not truncate silently. The tool layer already renders the flag; nothing raised it. The accumulator is now a small `CappedStream` that reports hitting its cap, and reports it at the first byte past it rather than at exactly the cap.

- **Two concurrent spawns could both take the last delegation slot.** The width cap counted a parent's children and then created one, with every other provisioning step in between. Two spawns under the same parent both read the same count, both saw room, and both created, so a cap of N admitted N+1. Provisioning is now serialized per parent session — the narrowest key that makes the check and the write one critical section; spawns under different parents never contend. In-process only, which is the honest scope: cross-process capacity belongs to the store.

- **`agent_task_list` forgot finished workers.** Terminal tasks leave the manager 30 seconds after they settle, and the gateway's list was rebuilt by looking each tracked id back up — so a task that finished a minute ago vanished from the exact tool whose description says to call it before declaring multi-worker work done. A supervisor could not tell an evicted task from one that never launched; both read as absence. The gateway now snapshots each task's settled summary while the manager still holds it, and prefers the live record whenever there is one.

- **The compaction summary hid its dropped tool results.** Every capped section in the working-state summary appends a line naming what it evicted — except tool results, which counted their evictions and rendered without them. The section carrying the most volume was the only one presenting a fragment as the whole record.
