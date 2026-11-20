---
'@namzu/sdk': minor
---

New tools for a host that has a person present: `buildSessionTimerTools` (`timer_set`, `timer_list`, `timer_cancel`) for prompts the model sets to fire into the conversation once or on a schedule, and `buildWakeUpTool` (`wake_up`) with `clampWakeUpDelay` for a loop the model paces itself. `session_loop` `create` may now leave out `interval` to start a self-paced loop, and `SessionLoopHost.create` receives no `interval` then, so a host implementing it must handle that (`SessionLoop.paced` marks such a loop). Nothing changes for a host that does not register the new tools; `session_loop` with an interval and `schedule` behave as before.
