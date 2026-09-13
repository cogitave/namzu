---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Add optional `RunEvidenceSearchOptions.excludeSuccessfulTools` to omit successful
results from up to 16 exact tool names during bounded discovery. The default
excludes nothing. Filter membership is bound to continuations; exact reads stay
available and errors or unknown provenance remain searchable. Search results and
`EvidenceRecallBatch` can report optional `excludedToolResults`, counting skipped
visits rather than unique facts. A positive count can produce an explanatory
recall context even when no passage is selected.

Preserve tool name and explicit error status in compacted text when the same
record contains an unambiguous, correctly ordered call/result pair. Newly written
large compaction archives retain that metadata; older archives without it stay
unknown. Text addresses, original messages and copy timestamps are unchanged.

When CLI automatic evidence recall is enabled, successful `search_conversation`
and `read_conversation` results no longer occupy its initial candidate slots,
allowing original observations behind repeated archive quotes to be considered.
Automatic cursors preserve this filter. Start a new literal search without that
cursor to inspect the quoted search/read results. This fixes candidate pollution
without increasing budgets or changing the default-disabled recall option.
