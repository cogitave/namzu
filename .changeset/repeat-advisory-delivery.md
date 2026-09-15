---
"@namzu/sdk": minor
"@namzu/cli": patch
---

The repeat-call advisory (notices, then escalates, when a tool is called with identical arguments over and over) now reaches the model even when the repeated tool's result is structured content — an image, a document, an MCP resource block — rather than plain text. `attachRepeatNotice` previously required the trailing tool result to be a string and silently dropped the notice otherwise; it now falls back to delivering the advisory as its own runtime-context message immediately after the tool-result batch. No thresholds changed, and a repeat that keeps succeeding is still only ever noticed, never refused.

`RuntimeContextMessageKind` gains a `'repeat-call'` member for this fallback message. A consumer that exhaustively switches over the union (the CLI's transcript labeling did) needs a case for it; `@namzu/cli` adds one in this release.
