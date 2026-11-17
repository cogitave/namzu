---
'@namzu/desktop': patch
---

The Browser pane is now a real browser page: tabs with the page title and a plus, Back, Forward and Reload, and an address bar you can type into that shows the whole local path of a file or the web address. A page a turn writes opens in it by itself with its own scripts and styles, and `http` and `https` addresses work. Each conversation's pages run in a separate, non-persistent browser session with no Node access, no preload and every permission (camera, microphone, notifications, downloads) denied, and a local file opens only from the conversation's work folder. The conversation menu gains "Keep computer awake" (this conversation only), the message box hint is one short line that no longer makes the box two lines high ("Ctrl+Enter to queue" while a reply runs), and the time and buttons under a reply, a command's output and the rows of an opened group line up.
