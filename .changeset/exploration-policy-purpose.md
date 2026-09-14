---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Learning candidates and learning cycles can declare `purpose: 'exploration'` for instructions intended to improve an explorer. Their purpose is covered by the content digest, and generation cannot redirect the host-admitted purpose. A skill cannot change purpose under the same name.

`projectResidentLearning` continues to select task guidance by default. Exploration policies require an explicit matching purpose and are reported as `different-purpose` when withheld. Existing skills without a purpose retain their task behavior and hashes. CLI resident steps therefore keep exploration policies out of ordinary task context. Explicit exploration projection still requires matching source revisions and does not grant tools or start inference.
