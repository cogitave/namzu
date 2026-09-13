---
"@namzu/sdk": minor
"@namzu/cli": major
---

Resident run/start now automatically retrieve bounded original tool evidence
from earlier settled admissions before model requests, under both context
profiles. Previously these admissions exposed explicit archive tools only.
Set `compaction.recallEvidence: false` to retain that previous behavior. This
adds local archive I/O and request context; it does not add query-planning
inference, replay actions or grant ordinary chats/delegated agents access.

SDK hosts can attach `createResidentEvidenceRecallStep` to an admitted run.
It preserves historical Session/run/claim addresses and shares bounded evidence
selection with conversation recall. Resident tool sources also support bounded
token queries and exact cursor-only recovery, retaining query/filter identity
across reopening. Incomplete results do not establish absence.

Resident Sessions now leave signal handling to their enclosing host. Previously
the SDK emergency handler could exit immediately on SIGINT/SIGTERM before the
host wrote cleanup/runner receipts. Cancellation now drains through the resident
lifecycle and preserves the interrupted claim for inspected reconciliation.
