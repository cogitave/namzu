---
'@namzu/sdk': patch
---

A turn whose tool inputs or results contain a very long unbroken run of capital letters, or a long run of dots, dashes or slashes inside one word, no longer freezes before the next model request. The compaction scorer split such a token with patterns (the capitals split and the separator trim) that took time quadratic in the length (about 30 seconds for 150,000 characters, per call) and tokenized every message twice; it now splits in linear time and tokenizes each message once. Scores, budgets and spills are unchanged; nothing to do on upgrade.
