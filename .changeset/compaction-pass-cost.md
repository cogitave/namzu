---
'@namzu/sdk': patch
---

The salience compaction pass is cheaper and chooses exactly what it chose before. Each message's tokens, term frequencies and signature are computed once and kept with the message, so a pass no longer re-reads the whole history (a 1,500-message pass fell from about 90 ms to about 6 ms of one uninterrupted block), and a pass skips scoring when nothing outside the leading system run and the recent window is a clearable result or a long narration. Scores, the messages stubbed or cleared and their order are unchanged; nothing to do on upgrade. A salience pass that cannot shed anything and is below the summary trigger no longer starts at all: its `pre_compact` and `post_compact` hooks and its `compaction_started` event no longer fire for a pass that did nothing. At the trigger, when forced, and with a host reducer, the pass starts as before. A host that counted those hook calls or events as "compactions" now sees only the passes that could act.
