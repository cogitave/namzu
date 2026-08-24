---
"@namzu/sdk": major
"@namzu/cli": patch
---

Add `runtime-context` to `UserMessageSource` and tag SDK-authored user-role
messages with the reason they were inserted. Consumers that exhaustively switch
over `UserMessageSource` must handle the new member; persistence layers must
preserve it instead of reclassifying the message as operator input.

The CLI now renders, edits, resumes, validates and exports these durable messages
as runtime context rather than as text typed by the operator.
