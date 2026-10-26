---
'@namzu/sdk': patch
---

A turn whose tool inputs or results contain a very long unbroken run of capital letters, or a long run of dots, dashes or slashes inside one word, no longer freezes before the next model request. The compaction scorer split such a token with patterns (the capitals split and the separator trim) that took time quadratic in the length (about 30 seconds for 150,000 characters, per call) and tokenized every message twice; it now splits in linear time and tokenizes each message once. Scores, budgets and spills are unchanged; nothing to do on upgrade.

A batch of many large tool calls in one turn also no longer fails with "a tool_review_requested record is N bytes; the limit is 4194304": the review record now keeps a leading excerpt (with the full length) of any input above 8 KiB once the batch passes 1 MiB. The full inputs stay on the log in the assistant message and in each tool input record, except that a single input over 1 MiB is recorded in its tool input record as its length and a leading excerpt (the assistant message keeps it whole), so one very large write no longer fails the turn on the record cap.
