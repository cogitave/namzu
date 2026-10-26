---
'@namzu/cli': patch
---

Answering "Yes, and don't ask again" on one shell call now also covers the identical calls waiting behind it, so they run without a second question. The last of several questions keeps its `k of N`, and Ctrl+C at a question ends the turn the way a plain No does, with one `Interrupted` row and the unasked calls shown as not run.
