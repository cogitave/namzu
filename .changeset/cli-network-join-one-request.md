---
'@namzu/cli': patch
---

A machine asking to join your Namzu network no longer fills the conversation with one line per try. Terminals of the asking machine share one request (one code), the footer shows `1 join request · /peers` while any wait, each machine gets one passing footer line per session instead of a transcript row, and `/peers` lists join requests first. After a Deny a machine waits an hour before asking that network again on its own (`namzu peers join <address>` asks at once).
