---
'@namzu/sdk': patch
---

On Linux, stopping a background job (and a command that is cancelled or times out) now also stops descendants that left its process group with `setsid` or a double fork; before, they kept running with nothing that could name them. Every command the host starts now has a `NAMZU_SHELL_TAG` variable in its environment, which a command can see. A descendant that clears its environment still escapes, and systems without `/proc` signal the process group only.
