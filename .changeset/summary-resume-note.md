---
'@namzu/sdk': patch
---

A compaction summary now ends with one short paragraph telling the model how to continue: carry on from where the summary says the work stood without asking the person to repeat it, treat steps it marks done as done, read a file again before editing it, and check first on anything still running or waiting. The paragraph is exported as `COMPACTION_RESUME_NOTE` and comes after the recovery pointer. `COMPACTION_HEADER` is unchanged. A host that compares a summary message's whole text, or expects it to end on the recovery pointer, now sees this paragraph last; one that tests for the header is unaffected.
