---
"@namzu/cli": patch
---

Validate returned archive pages before exposing their text or caching an address.
Conversation search, exact reads and automatic recall now consistently reject
pages with mismatched ownership, invalid retrieval bounds or inconsistent text
positions. Exact reads also reject a wrong sequence/part during address lookup
and discard results returned after cancellation. Faulty captured sources report
unavailable evidence instead of contributing text to the conversation. Existing
built-in storage integrity checks and retrieval limits are unchanged.
