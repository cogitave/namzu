---
'@namzu/cli': patch
'@namzu/desktop': patch
---

A normal start no longer logs a warning for being offline: the Zen model catalogue refresh reports an unreachable network at debug level, and skips the network when the saved copy is under six hours old, so Desktop's several engines do not each fetch it. A saved project folder that cannot be reopened at start is recorded as missing, unreadable or not a folder and the remaining projects still restore; reads for a project that is still connecting, missing or failed to open no longer fail.
