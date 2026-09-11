---
"@namzu/sdk": minor
---

Add opt-in experimental resident-agent state and bounded continuation: `DiskResidentStore`, `ResidentStore`, `stepResident` and `runResident`. Hosts can persist one identity and pursuit across conversations, schedule another step or rest without model calls, and prevent competing owners from admitting the same step. Failed or interrupted steps remain unresolved until explicitly reconciled; no automatic process takeover, external notification delivery or CLI behavior change is introduced.
