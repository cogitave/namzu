---
'@namzu/cli': patch
---

**`/tools` lists the tools the agent can call now, not the ones it could call
when the session opened.**

Some tools register during the first turn rather than at connect — the agent's
own task tools are the ones that do it today. `/tools` was answering from a list
captured before that happened, so those tools were missing from it for the whole
session.

The visible symptom was two commands disagreeing on one screen: `/permissions`
reads the roster live and would name a tool as never-prompted that `/tools` did
not list at all, which reads as namzu having invented a tool name.

The connect line (`Connected to … · N tools`) is unchanged and still reports the
count at connect time, because it describes a connection that has just happened.
