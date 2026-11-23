---
'@namzu/cli': patch
---

`/context` (and `/context details`) now answers at once while a reply is running, instead of waiting for the reply to end; it adds one line saying the numbers are as of the last finished reply. A slash command that still waits (`/compact`, `/init`, `/clear` and the rest) shows in the pending rows as `/command · Queued, runs after this reply`. The WSL guidance now tells the model not to check, list or focus a window with the screen tools after opening a program or file for you unless you ask. Nothing to change on your side.
