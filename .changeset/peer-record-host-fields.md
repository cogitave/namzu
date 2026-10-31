---
'@namzu/sdk': minor
---

A live-session registry record can now carry four optional fields: `hostSlot`, `conversationId`, `account` and `limited`. A spaces host uses them to match a terminal to its sidebar row and to show which conversation, account and allowance state it is on. Records without them are unchanged and still valid, and readers from the previous release keep seeing records that have them.
