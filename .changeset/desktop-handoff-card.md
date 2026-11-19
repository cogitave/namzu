---
'@namzu/desktop': patch
---

When a tool needs you to do something outside the chat, such as signing in to a site, finishing a second step or passing a check, Namzu now says so and lets you carry on. Before, the reply just read "Paused", the only text said it was "waiting for a decision", and sending a message was refused, so the conversation was stuck and you had to start another. Now a card above the message box says what to do in plain words ("Sign in to github.com in the browser window Namzu opened, then choose Continue."). Continue picks the reply up where it stopped without sending anything again, Stop (Esc) ends it and keeps the conversation, and typing a message instead moves on without it. Enter on the number pad now presses a focused button just as the main Enter does. If the browser Namzu drives has no window on this computer, the card says so and gives the one command that opens a window to sign in with.
