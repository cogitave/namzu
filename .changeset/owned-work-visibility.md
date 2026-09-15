---
"@namzu/sdk": patch
---

`CompletionInbox.describeOwnedWork()`'s owned-work projection no longer drops a still-running task purely because more tasks were launched after it. It used to keep a single FIFO over every owned task, so a long-running task launched early fell out of the model's visibility permanently once sixteen more tasks were merely LAUNCHED — whether or not any of those newer ones had actually finished.

It now lists running tasks first, most recently launched first, and fills whatever slots are left with the most recently settled tasks — still bounded to sixteen entries. A running task that does not fit is named honestly in the preamble ("N running tasks are shown below, and N more still running.") instead of disappearing without a trace. A settled task bumped out is not individually counted; its result already reached the model once, inline or as a notification.

Model-facing text only. No exported symbol, method signature or wire shape changed.
