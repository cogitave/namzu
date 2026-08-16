---
'@namzu/sdk': minor
---

New optional `compactionConfig.keepRecentTokens`. When set, the retained conversational tail is sized by tokens instead of by `keepRecentMessages`. Absent by default, so every existing run keeps the same tail it kept before.

`keepRecentMessages` cannot say what a tail costs. Four messages is four short turns, or three short turns and a 200 KB tool result — and in the second case the retained tail alone can approach `resetThreshold`. The pass then completes, reports it did not reach the threshold, leaves the trigger armed, and the next iteration pays another summarization call and busts the prompt-cache prefix again.

It replaces only the naive boundary. The existing safe-cut search runs downward from wherever the token walk lands, so a `tool_use` is never separated from its `tool_result` — that guarantee holds by construction rather than by a second check.

The tail is floored at one message. A single final message larger than the whole budget is still kept: it is the live turn, and dropping it to satisfy a size preference would delete what the run is answering. The pass reports that it did not reach the reset threshold, which is the honest outcome.
