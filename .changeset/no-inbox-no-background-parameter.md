---
'@namzu/sdk': major
---

`create_task` offers `background: true` only when there is somewhere for the result to arrive

A background launch returns a task id and tells the model its result will come
"later, as a task notification". The `CompletionInbox` is the only thing that
delivers one — it holds the run open for the outstanding worker and puts the
completion into the transcript. `buildCoordinatorTools` mounted the parameter
whether or not it was given an inbox, so a host without one had a tool
advertising a channel that did not exist. Nothing failed loudly, because the
launch itself succeeded; the result simply never arrived.

Without a `completionInbox`, `create_task` no longer declares `background` and
its description no longer mentions it. Everything else is unchanged: the
blocking path, `wait_for_task`, `cancel_task` and `agent_task_list` are all
still mounted. Pass a `completionInbox` — to `buildCoordinatorTools` **and** to
`drainQuery` — to get background launching back. `SupervisorAgent` does both
already, so a host using it sees no change.

Withheld rather than refused per call, and rather than thrown at construction.
A parameter the model is never shown costs nothing; one it is shown and then
denied costs prompt-prefix tokens plus an iteration per attempt. And a throw
would break a caller doing something legitimate — an inbox-less coordinator
surface is a supported configuration. This is the same reasoning that made an
empty roster withhold `create_task` rather than refuse to build.
