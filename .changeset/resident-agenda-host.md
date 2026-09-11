---
"@namzu/sdk": minor
---

Add experimental `DiskResidentAgenda` and `ResidentHost` APIs for multiple persistent pursuits under one agent identity. Shared admission prevents overlapping pursuits across local processes; pause persists across restart, while resume explicitly reopens admission and wake interrupts local idle waiting. Interrupted admitted work remains unresolved until the host stops its executor and reconciles effects. Storage contention retries preserve the exact target claim and never repeat its callback. These APIs do not start a daemon, send notifications or change CLI defaults.

Expose `ResidentAgendaStore`, `ResidentAgendaState`, `ResidentPursuit`, `ResidentPursuitStep`, `ResidentHostRunOptions`, `ResidentHostResult` and the narrower execution dependency `ResidentExecutionStore`. Agenda snapshots include an optional `ResidentState.pursuitId`; standalone snapshots omit it. Fix cancellation during an asynchronous state read and safely address long Unicode agent keys while preserving existing filesystem segments that fit the filename limit.
