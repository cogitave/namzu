---
'@namzu/cli': patch
---

A fork sub-agent no longer fails before its first request when the conversation it continues holds saved messages. A child that fails now says why in plain words on its row and in the parent's result, instead of showing an internal refusal.
