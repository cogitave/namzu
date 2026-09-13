---
"@namzu/sdk": patch
---

Treat uppercase and lowercase hexadecimal spellings of the same UUID as the same identity when joining and deduplicating resident consumption evidence. A copied root receipt can no longer count twice merely because its UUID spelling differs. Original identifiers remain available to the host resolver.
