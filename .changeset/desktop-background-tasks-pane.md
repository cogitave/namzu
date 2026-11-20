---
'@namzu/desktop': patch
---

Background commands and monitors now have their own pane, Background tasks, opened from a button in the top bar (shown once the conversation has a task) or from the composer. It lists what runs and what finished, shows how long each took and how it ended (Failed, Stopped, Ran out of time), lets you open a task to read the end of its output live, stop it, and clear the finished ones. The Session panel keeps only a short list with a link to the pane, the composer's "shells" count now reads "running tasks" or "tasks finished", and a command that went to the background says in the conversation whether it is still running, finished, failed or was stopped. Nothing to change on your side.
