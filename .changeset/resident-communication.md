---
"@namzu/sdk": minor
---

Add optional resident communication APIs. Hosts can prepare a validated outbound message and commit its intent with pursuit settlement and observed progress in one agenda revision. `deliverResidentMessage` claims one pending message, applies host delivery gates and records destination acknowledgment separately from generated content. Uncertain sends stay unresolved until explicit host reconciliation; retries require evidence of non-acceptance. No external channel, CLI default or automatic background service is enabled.

Add `createResidentDeliveryWindow` for daily allowed hours in an explicit named timezone, including overnight windows and DST transitions. Delivery callbacks remain host-owned and must enforce recipient authorization and receiver idempotency.

Agenda schema 3 retains up to 128 immutable intents including acknowledged/cancelled entries for deduplication. Schemas 1 and 2 remain readable; older writers refuse schema-3 records. Custom stores opt into atomic message settlement and delivery methods. This prototype has no outbox archival, automatic ambiguous-send takeover or exactly-once remote-delivery guarantee.
