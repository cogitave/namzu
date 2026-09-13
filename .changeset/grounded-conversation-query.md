---
"@namzu/sdk": minor
"@namzu/cli": major
---

Add optional run-metered, tool-free `PrepareStepContext.generateText` and
`createEvidenceRecallStep({ resolveQuery: true })` for resolving historical
follow-ups against bounded visible conversation. Generated search terms must
occur in the question or exact cited history. SDK query resolution defaults off.

In the CLI, conversations with `compaction.recallEvidence: true` now resolve
eligible conversational queries by default. This can add one provider request
per operator input, up to 512 output tokens and ten seconds before local
retrieval. It consumes the same run token budget. Set
`compaction.resolveEvidenceQueries: false` to keep the previous literal-query,
local-only behavior. Automatic recall itself still defaults off.
