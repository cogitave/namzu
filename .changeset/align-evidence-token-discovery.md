---
"@namzu/sdk": minor
"@namzu/cli": patch
---

SDK evidence sources now accept `matchMode: 'token'` for complete Unicode
letter/number/underscore terms, with the same lowercase keys used by bounded
evidence ranking. The default remains literal substring search. Token queries
must contain one token per term; use literal mode for phrases or punctuation.
Continuations retain their matching mode, and token search authenticates the
preceding chunk when checking a word boundary within the existing I/O budget.

CLI automatic evidence recall uses this mode to keep incidental substrings
such as `in` inside `Packing`, or `3` inside `13000`, from consuming its candidate
slots. Explicit conversation search still supports literal substrings.
Whole-word frequency can still limit bounded discovery; this change does not
claim complete or globally ranked archive retrieval.
