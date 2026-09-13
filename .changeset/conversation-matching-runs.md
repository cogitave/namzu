---
'@namzu/cli': patch
---

Conversation search can return matches from several completely searched runs in one call instead of stopping at the first matching run. The existing result limit, 12,000-byte match allowance, 8 MiB read ceiling and bounded directory discovery still apply. The host reserves output space before each SDK operation and adjusts its requested match count to the available room, including escaped text and source metadata. Partial index pages still yield their continuation, and missing or changed evidence remains incomplete. Callers should continue to use returned cursors rather than assume a page belongs to one run.
