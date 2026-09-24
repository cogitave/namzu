---
'@namzu/cli': patch
---

`namzu schedule status` on Windows and WSL now says what the Task Scheduler's last result means, keeping the number: `last result: running (267009, 0x41301)` instead of `last result 267009`. The result that appears every five minutes while the scheduler runs, `-2147020576` (0x800710E0), reads `an instance was already running, so a new one was not started; expected, since the task checks every five minutes`, so it is not mistaken for a failure. Task Scheduler's own codes, the common Windows errors and the scheduler's own exit codes are named; any other result shows its number and its hexadecimal form.
