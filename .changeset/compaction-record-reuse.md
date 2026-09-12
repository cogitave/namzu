---
"@namzu/sdk": patch
"@namzu/cli": major
---

Avoid reading and parsing a shared compaction record once for every removed
message. A search reuses one authenticated record within that operation; later
calls revalidate it. Text manifests, integrity checks, cancellation and page
limits remain in effect.

CLI manual compaction now stores one `compaction_shed` event containing all
removed messages, matching automatic compaction, instead of one event per message.
Consumers of raw manual-maintenance events must iterate the `messages` array
and use search results' `seq` and `part` addresses, rather than assuming `part: 0`
or one sequence per message. Existing archives and SDK event readers remain
supported. No config change is required for ordinary CLI use.
