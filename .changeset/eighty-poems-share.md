---
'@namzu/sdk': minor
---

A host can now steer a turn that is already running.

`AgentManager.queueMessage` and `drainMessages` have existed for a while and
nothing in the iteration loop ever read them — the type said so outright. So a
host watching a run go the wrong way had two options, both worse than they
sound: cancel and start over, throwing away every tool result already paid
for; or reject through the review gate, which only works when a call happens
to be pending approval and says "no" when the host meant "yes, but read this
first".

`SteeringChannel` is the delivery that was missing. A host holds one, passes
it as `steering` on `drainQuery` params or `SupervisorAgentConfig`, and calls
`steer(text)` whenever it likes. Anything queued while a tool batch is running
is appended to that batch's **last tool result**.

That slot is not a stylistic choice. A `tool_use` block must be answered by a
`tool_result` with the same id, so a user message wedged between them is
rejected by the provider — there is no legal place to insert one mid-batch.
The tool result is the slot that already exists, and this SDK had already
reached that conclusion for the neighbouring case: a denied call carries its
reason inside the `tool_result`, precisely because that is where the model
looks for tool outcomes. Steering is the same delivery with the refusal taken
out.

It deliberately does not interrupt. The batch in flight finishes and the
guidance lands where the model reads next; a host that wants the current work
stopped wants `AbortSignal`, which is a different question. Conflating them is
how "also check the tests" ends up killing a half-written file.

Details worth knowing:

- Repeated calls before a drain accumulate in order rather than replacing each
  other — two corrections typed a second apart are two things the model should
  see.
- Guidance is labelled as coming from the operator. Unlabelled it would read
  as something the tool said, so "stop and ask me first" would look like
  output from `bash`. This is not the untrusted-content envelope: the operator
  is the one party whose words the agent *should* act on.
- A turn that called no tools has nothing in flight, so guidance stays queued
  for the next one instead of being dropped.

Absent, the loop is byte-identical to before.
