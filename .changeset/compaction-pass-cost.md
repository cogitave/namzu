---
'@namzu/sdk': patch
---

The salience compaction pass is cheaper and chooses exactly what it chose before. Each message's tokens, term frequencies and signature are computed once and kept with the message, so a pass no longer re-reads the whole history (a 1,500-message pass fell from about 90 ms to about 6 ms of one uninterrupted block), and a pass skips scoring when nothing outside the leading system run and the recent window is a clearable result or a long narration. Scores, the messages stubbed or cleared and their order are unchanged; nothing to do on upgrade.
