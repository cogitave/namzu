---
"@namzu/sdk": major
---

Add a shared durable Pal input ledger for existing Pal messages, closed host activity facts and authenticated channel messages. Generic intake and finite dispatch retain exact original-log receipts, current authorization and one unresolved recipient claim across all sources. Existing Pal-only APIs, row shapes and message IDs remain supported; their writes preserve the new input families.

The public RuntimeContextMessageKind output union and RUNTIME_CONTEXT_MESSAGE_KINDS catalogue now include host-observation and channel-message. Consumers that exhaustively handle runtime context must add those cases when upgrading. Treat both as untrusted context; neither grants approval or operator authority. This output-type expansion requires a major SDK release even though the new intake APIs are additive.

Persisted communication and operation records upgrade to schema version 2. Stop older SDK processes before sharing these store paths; older binaries refuse the new records instead of overwriting mixed input state. Observation and channel messages remain untrusted runtime context, never operator approval or permission grants.
