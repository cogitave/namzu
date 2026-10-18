---
'@namzu/desktop': patch
---

A shell command now reads as one row with its output under it: the first three lines, then "+N lines" to open the rest, errors in the error colour, "Exit code N" said once instead of beside the command as well, and "(No output)" for a command that printed nothing. A command that was handed to a background job says "Running in the background" with a "See it" action, and the run's header counts it ("Ran 4 commands, 1 failed, 1 in the background").
