---
'@namzu/ollama': patch
'@namzu/lmstudio': patch
'@namzu/anthropic': patch
'@namzu/bedrock': patch
'@namzu/openrouter': patch
'@namzu/http': patch
---

Declare honest driver capabilities on each provider instance.

Every shipped driver now exposes `readonly capabilities` (and
re-exports its `*_CAPABILITIES` constant from the client module)
describing what the DRIVER does — not what the vendor API could do —
so the SDK's capability negotiation can warn instead of silently
degrading:

- `@namzu/ollama`: `supportsTools: false`, `supportsVision: false`
  (the driver never sends tool schemas and drops image attachments).
- `@namzu/lmstudio`: `supportsTools` corrected `true` → `false` and
  `supportsFunctionCalling` `true` → `false` — the driver folds tool
  messages into user text and never sends tool schemas;
  `supportsVision: false`.
- `@namzu/anthropic`: full (`supportsVision: true` — image attachments
  already mapped).
- `@namzu/bedrock`, `@namzu/openrouter`, `@namzu/http`: tools pass
  through (`supportsTools: true`) but `supportsVision: false` until
  their message translation maps attachments.
