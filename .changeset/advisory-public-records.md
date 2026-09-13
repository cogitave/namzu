---
"@namzu/sdk": patch
---

Fix configured advisors losing rich tool-result text and tool-call details in
conversation context. Public records now retain roles, host provenance, call
IDs, names, arguments and explicit result status; media content and private
provider replay state are omitted.

The existing `maxContextTokens` window now counts serialized records, including
rich text, metadata and escaping, instead of array element counts. Tight windows
may retain fewer complete records; increase the configured window if needed.
The unbounded default is unchanged. Omitted records are explicitly identified.
