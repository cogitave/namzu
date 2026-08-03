---
'@namzu/sdk': minor
---

Make the loop-control surface reachable from the Agent classes, and stop
gating environment context on built-in tool names.

Found by auditing the one application in the estate that actually consumes
`@namzu/sdk`, rather than by reading the SDK again.

- **`ReactiveAgent` forwarded none of the loop-control seams.** It is what
  `AgentManager` spawns and what real applications call, and it passed only
  provider/tools/runConfig — so `toolTimeoutMs`, `retry`, `emergencySave`,
  `stopWhen`, `onStepFinish`, `prepareStep`, `structuredOutput`,
  guardrails, `repairToolCall`, `maxToolConcurrency`, `maxToolOutputChars`,
  `resumeHandler` and `checkpointStore` were reachable only by dropping to
  `query()` and rebuilding the run wiring by hand. A feature a consumer
  cannot reach is a feature that does not exist for them.

- **The `<env>` block keyed on four hardcoded tool names.** A host
  registering a filesystem tool called `read_file` — declaring
  `category: 'filesystem'` and `permissions: ['file_read']` correctly — got
  no environment context at all, so the model was never told its working
  directory and the host hand-encoded paths into its system prompt. The
  gate now reads what a tool declares, keeping the name set as a fallback.

- **Providers were handed the run's live message array.** `runMgr.messages`
  is the live array and the loop pushes onto it after the call returns, so
  a driver that retained its input — to log it, cache it, or replay it on
  retry — watched it grow new turns underneath. A capture provider in the
  estate recorded every turn as identical to the last for exactly this
  reason. The array is now copied at the provider boundary.
