---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Expose optional `excerptComplete` on retained-evidence search matches and recall candidates. Built-in sources prove whether the displayed excerpt contains a whole full-retained text part using validated UTF-8 bounds. A partial excerpt or retained preview reports false; custom sources that omit the field remain unknown.

CLI conversation search and automatic recall preserve this information and explain when reading the same unchanged part adds no text or independent evidence. The field describes one text part, not the truth of its claims or coverage of the whole conversation. Existing scope, integrity, cancellation and context limits remain enforced.
