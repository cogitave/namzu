---
'@namzu/cli': minor
---

Archived conversations can now be listed and restored in their original project with `/unarchive` or `namzu archive list|restore`. Restore one before using `namzu resume <id>`; the conversation history stays in its original log and remains scoped to its project.
Long-lived CLI sessions refresh their project archive listing when another process archives or restores a conversation.
