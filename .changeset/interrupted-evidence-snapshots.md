---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Read retained original observations after a process exits before recording a
terminal run status. Disk evidence factories accept `consistency: 'snapshot'`
for explicitly scoped nonterminal runs; the existing default remains `closed`.
Snapshot reads validate ownership and unchanged source bytes on every operation
without acquiring an execution lease, resuming tools or changing run metadata.

The CLI now uses this mode for recorded `idle`, `pending` and `running` runs
outside its requesting live writer. An incomplete final JSONL fragment is
excluded within the existing bounded I/O allowance without editing the source.
Search remains incomplete for nonterminal snapshots; a full read describes only
the selected retained text. File or metadata changes require a fresh search,
and missing or altered retained originals remain unavailable.
