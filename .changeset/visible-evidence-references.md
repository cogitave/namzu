---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Automatic evidence recall now retains bounded source references for exact text already visible in conversation history. The temporary context can contain `visibleEvidence` entries binding an exact bounded `textQuote` to an `address` for a host archive-read tool, recording time when known, source and retention/error metadata. `omittedVisibleEvidence` reports references withheld by the existing character limit. Quotes repeat at most 512 UTF-16 units to make the source association explicit; full records remain available through the read address. Visible quotes and new passages share `maxPassages`, with new text taking priority.

An otherwise complete recall pass may now return source metadata even when all matching text is already visible. Consumers should not assume every recall block contains new passage text. New-text ranking is independent of visible copies, and source ownership, revalidation, read limits and cancellation remain enforced. CLI models can use each reference's `address` with `read_conversation` to recover the exact source association without searching again or replaying an action.
