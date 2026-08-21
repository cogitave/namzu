---
'@namzu/sdk': patch
'@namzu/cli': patch
---

Make disk-backed memory reads and mutations fail closed on incomplete,
malformed, unsafe, or uncommitted durable state.

Indexed content is now validated before it is returned or updated. Missing
content, invalid JSON, newer schemas, mismatched IDs, invalid field shapes,
unsafe filename IDs, and content directories resolving outside the memory
root refuse the operation instead of becoming a false not-found or success.

Disk-memory operations sharing one canonical index path are serialized within
the SDK process and reload the authoritative index before acting. Concurrent
CLI parent/delegate saves no longer lose all but the last record, warmed
readers observe sibling writes, and create/update/delete publish live state
only after their required durable operations succeed. Cross-process writers
still require a single owner or storage-level conditional publication.
