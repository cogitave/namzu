---
'@namzu/cli': minor
---

The desktop host adds two methods, `namzu/conversations/archived` (list a project's archived conversations) and `namzu/conversations/unarchive` (restore one by `sessionId`). Both require folder trust, and restore only admits an owned, archived, non-Pal conversation. Existing methods are unchanged; nothing to do on upgrade.
