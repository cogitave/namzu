---
'@namzu/sdk': minor
---

a narrowed step now narrows what can RUN, not only what the model is shown

`prepareStep.activeTools` documents itself as *"restrict which tools the model
may call this step, by name"*, and run-level `allowedTools` makes the same
promise for a whole run. Neither restricted anything.

The list decided which schemas went into the request. It was then copied into
the tool context and read by nothing on the execution path — the registry gated
on availability and plan mode, and never on the allow-list. So the narrowing was
a statement about the menu rather than about the kitchen: a model that named a
withheld tool had it run.

That is not a hypothetical. A model names a tool it was not offered whenever it
repeats a call from earlier in the context, whenever a gateway carries its own
tool list, and whenever a cached prompt prefix is replayed. A host using this to
fence a step — the obvious use, and the one the type invites — was fenced by
nothing.

The check now sits where the call is made. A tool outside the list is answered
with a refusal that names what IS available, so the model can route around it
rather than guessing.

Two details worth stating:

- **Absent is not empty.** No list means no restriction; an empty list means the
  step may call nothing. Reading an empty allow-list as "unrestricted" is the
  fail-open this repository has already been bitten by once, in the delegate
  roster.
- **A step's list beats the run's,** matching the precedence the request already
  used, so the two can no longer disagree.

**If you pass `allowedTools` or `activeTools` today, calls that previously ran
may now be refused.** That is the point of the change, but it is a real
behavioural difference: a run that quietly depended on the leak will start
seeing refusals. The refusal is a normal `tool_result`, so the turn continues.
