---
"@namzu/cli": minor
"@namzu/sdk": patch
---

Interactive terminals in the same project can discover and message one another
with `/peers`, `list_sessions` and `send_session_message`. Idle terminals can
start a turn for peer context; busy terminals receive it at the next safe
request boundary. Peer input remains separate from operator instructions and
cannot grant approval. Different permission modes are refused. Use `/peers off`
to refuse new mail and pause delivery in this terminal.

The mailbox is bounded and process-local; queued is an acceptance receipt, not
proof of model delivery. Conversation switches cannot redirect pending mail.
Child-task activity now labels accepted messages as queued, and SDK manager
documentation describes the inbound callback that query-backed agents actually
consume. The SDK peer envelope refers to the host's reply tool rather than
prescribing a CLI child-task tool.
