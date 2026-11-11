---
'@namzu/desktop': patch
---

Namzu Desktop no longer keeps asking a Pal's computer that is not set up: it reads it once, shows one setup card (what it is, Get Docker Desktop, about 1.2 GB of disk; a stopped Podman machine gets a card that says to start it instead) and asks again only when you come back to the window, start the computer or finish setup. The task list and pull request look try again when the window is focused. Failed reads of the undo status, your message settings and the model list now say what is wrong in plain words, are tried once more when Namzu reconnects, and no longer repeat on a timer. An undo status that cannot be read has no message on screen (it is only recorded in the log). Nothing to change on your side.
