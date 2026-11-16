---
'@namzu/cli': minor
---

In a Desktop conversation, the model is told in one line of its environment facts that Desktop shows the .html, .md and image files it writes in a preview pane, and that it should write the file and name it, starting a server only when the project has its own dev or start script and the person asked to run the app. The Desktop host also names each new conversation: after the first message it asks the small model for a title of at most 60 characters in the message's own language, saves it as a derived title (a name you chose is never replaced) and sends it as one new `namzu/session/title` notification. Nothing changes for the terminal or for a host that ignores the notification.
