---
"@namzu/sdk": patch
---

Honor MCP input schemas that explicitly declare dictionary values through
schema-valued `additionalProperties`, including the empty `{}` value schema.
Previously local validation silently removed those dictionary keys before
dispatch, so application input could report success with empty event data.
Retain declared keys, validate typed values and bound recursive dictionaries.
Existing omitted/false closed-object behavior, explicit true passthrough,
server trust, result provenance and execution guards remain unchanged.
