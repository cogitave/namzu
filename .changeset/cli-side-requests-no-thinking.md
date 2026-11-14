---
'@namzu/cli': patch
---

The one-line label under each running agent, and the title, recap, side question, memory and hook-judge requests that go to the small model, no longer starve on a thinking model: they ask for no reasoning where the provider can switch it off for one request and leave room for it where it cannot, and a label that was cut off keeps the previous one. The `Agent` tool's launch receipt now says `queued for an available slot` only for an agent that is waiting for one; a burst of four launches with room for two reports two as queued and two as still running, where it used to report the state from before the launch was admitted.
