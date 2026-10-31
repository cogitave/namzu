---
'@namzu/sdk': minor
---

A live-session registry record can now carry four optional fields: `hostSlot`, `conversationId`, `account` and `limited`. A spaces host uses them to match a terminal to its sidebar row and to show which conversation, account and allowance state it is on. Records without them are unchanged and still valid. A session started inside a spaces host writes them; a plain `namzu` session does not, so it stays visible to older builds. Builds before this release skip a record that carries any of them (they list the terminal as absent from `list_sessions` and peer messaging), so upgrade every build that shares a registry before starting a spaces host.
