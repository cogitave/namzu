---
'@namzu/cli': major
---

Interactive conversations now expose `read_conversation` to page exact retained
text using the `runId`, `seq`, and new `part` field from `search_conversation`.
Read and search cursors are distinct and expire; durable event addresses remain
usable after restarting without a cursor. Oversized records and bytes never
recorded remain unavailable.

The interactive prompt now includes a bounded context inventory when visible
tool output is large or context is under pressure. This changes default prompt
and tool-catalogue behavior. Embedders requiring the previous exact prompt and
catalogue must retain the previous CLI version or compose their host using SDK
hooks without the inventory/read tool. No SDK default changes.
