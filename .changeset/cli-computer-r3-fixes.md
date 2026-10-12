---
"@namzu/cli": patch
---

`namzu computer` and the Pal computer hint read better on Windows. The "Run namzu
computer setup" hint is chosen from the sandbox's setup code, not by matching its
message, and its wording no longer mentions wslc. A failed setup's `Details:` line
is a plain sentence with the Windows error number when there is one, not the
internal code. A pending restart reads "Restart your PC to finish setting up Pal
computers." instead of "Nothing needs to be set up.", and `namzu computer setup`
says it once without asking to continue. `--json` results from a failed setup gain
an optional `exitCode`.
