---
'@namzu/cli': patch
---

A model whose context window Namzu has to guess now says so: `/context` reads "a guess: this model's window is not known; set compaction.contextWindowTokens", and the transcript says it once per session with the same setting. The `/context` line no longer says "default for an unrecognized model".
