---
'@namzu/sdk': minor
---

a supervisor can decline to delegate without lying about its roster

`SupervisorAgentConfig` gains `allowDelegation?: boolean`, default `true`.

The roster answered WHO a run may call. Nothing answered WHETHER it may call
anyone, and the two are different questions. A host that runs one specialist by
putting its persona into the supervisor shell and its id into the roster has a
non-empty roster and must still delegate to nobody — and got the full
delegation surface, discovering the refusal only by spending a turn on it.

It cannot be derived. Comparing the roster against the executing agent fails in
exactly that arrangement, because the ids differ. And no predicate over the
roster could work: a supervisor whose roster holds one specialist and a run
that IS that specialist are indistinguishable in it. So the caller states the
fact and the SDK decides what it implies for its own tool surface — which also
means the implied list cannot go stale, the way a caller-held list of tool
names silently did when this surface went from two tools to four.

Details worth knowing:

- **`agent_task_list` stays.** A run that may not launch anything may still want
  to see what is running.
- **`approve_plan` and `ask_user_question` are untouched.** They are the
  human-in-the-loop surface, not delegation.
- **`allowDelegation: false` is absolute.** `runtimeToolOverrides` cannot put
  the tools back: the override pass runs over the tools this flag declined to
  build, and both values come from the same caller in the same call, so
  "must not delegate" plus "give it `create_task`" is a contradiction rather
  than extra knowledge. `agentIds: []` has always worked this way.
- **Absent and `true` are identical**, so adopting the flag cannot change a
  caller that opts in explicitly.
