---
'@namzu/sdk': major
---

New tools for a host that has a person present: `buildSessionTimerTools` (`timer_set`, `timer_list`, `timer_cancel`) for prompts the model sets to fire into the conversation once or on a schedule, and `buildWakeUpTool` (`wake_up`) with `clampWakeUpDelay` for a loop the model paces itself.

Breaking for a host that implements `SessionLoopHost`: `session_loop` `create` may now leave out `interval` to start a self-paced loop, so `SessionLoopHost.create` can receive no `interval` (`SessionLoop.paced` marks such a loop). Handle a missing `interval` by starting a self-paced loop, or refuse it with a message. Nothing changes for a host that does not implement `SessionLoopHost`; `session_loop` with an interval and `schedule` behave as before.
