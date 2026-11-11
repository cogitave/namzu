---
"@namzu/desktop": patch
"@namzu/cli": patch
---

In a second Desktop window, right-clicking a conversation that window had not opened showed no "Mark as unread", and Fork and Copy gave the wrong answer, because the menu looked at a thread that window never loaded. Main now keeps whether a conversation has a reply on its entry in the list, read from the saved log so it survives a restart, and every window follows it. A conversation with a reply offers Mark as unread, Fork, New side chat and Copy as Markdown in any window; Copy last reply says "Open the conversation first." until that window holds the text. A conversation with no reply is still not offered Mark as unread. The host's conversation list gains an optional `replied` field.
