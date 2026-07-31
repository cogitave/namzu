---
'@namzu/sdk': minor
---

`prepareStep` — shape each step before the model is called.

`stopWhen` let a run decide TO STOP from what its steps produced. This is
the other half: deciding how the next step should look. Without it, the
tool surface and the model were fixed at `query()` time, so a phased agent
— research with search tools, write with file tools, verify with a cheaper
model — had to be built as three separate runs, each starting blind to the
last one's context.

The hook receives the run id, the step number, the full message history and
every completed `StepResult`, and may return `activeTools`, `model`,
`system` (one-step guidance), `temperature` and `maxResponseTokens`. Any
omitted field keeps the run's configured value.

- `system` guidance is appended to the REQUEST, never pushed onto the run's
  history — otherwise a long run accumulates one stale phase instruction
  per iteration.
- `activeTools` does NOT touch `tool_choice`. Anthropic has no
  `allowed_tools`, and moving `tool_choice` invalidates cached MESSAGE
  blocks as well — a strictly worse trade for the same effect. Narrowing
  still costs the prompt-cache prefix, since tools render at position 0;
  that is inherent, and worth paying at a real phase boundary rather than
  every step.
- Unregistered tool names are dropped with a warning: a phase list that
  outlives a tool rename should narrow the surface, not kill the agent
  mid-run.
- Fails OPEN. A throwing hook leaves the step with the run's configuration
  — same reasoning as `stopWhen`, and deliberately opposite to a guardrail,
  because nothing unsafe gets through when step shaping is skipped.
