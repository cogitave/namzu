---
"@namzu/cli": major
---

Enable automatic historical evidence recall by default in recorded CLI conversations, including resumed conversations and resident turns using the conversation host. Previously, omitted `compaction.recallEvidence` disabled this preparation even when original tool text had been shortened to a retained preview.

Follow-ups may now make an additional bounded, metered model call to resolve the historical subject, then read scoped conversation evidence into the next request. This adds inference usage and possible latency; it shares the run's provider, effort, token budget and cancellation. Retrieval retains its existing four-page, 8 MiB read and 6,000-character context ceilings.

Set `compaction.recallEvidence: false` to retain the previous default, disabling both automatic archive reads and query-planning inference. Set `compaction.resolveEvidenceQueries: false` to keep automatic literal retrieval without the extra inference. Explicit archive tools remain available. SDK host defaults and stateless archive access are unchanged.
