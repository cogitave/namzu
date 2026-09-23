---
'@namzu/cli': patch
---

A parked scheduled run you approve or continue from the TUI is told the current local time again, since an answer can come long after the run started, and every time line now says it is the current time already looked up, so the model does not try to run `date` for it.
