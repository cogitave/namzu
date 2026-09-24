---
'@namzu/ag-ui': major
---

A paused turn now ends its AG-UI run as an interrupt the client can answer, and `RunAgentInput.resume` continues it.

**What breaks.**

- A native pause (`turn_paused`) used to end the run with a `CUSTOM` event named `namzu.turn.paused`, carrying the checkpoint id, followed by `RUN_ERROR` code `NAMZU_TURN_PAUSED`. It now ends with `RUN_FINISHED` whose `outcome` is `{ type: 'interrupt', interrupts }`, and the `CUSTOM` event is gone. A client that waited for `NAMZU_TURN_PAUSED` reads `outcome.type === 'interrupt'` instead; a host that resumed the checkpoint itself from the `CUSTOM` event's `checkpointId` sends the interrupt's answer in `resume` instead.
- `AGUIEventMapper.map` no longer emits anything for `turn_paused`: it sets `paused`, and the run ends with the new `interrupt(interrupts)`, or `finish()` reports `RUN_ERROR` code `NAMZU_TURN_PAUSED` as before, without the `CUSTOM` event.
- A request with `resume` is served instead of refused with HTTP 422 `UNSUPPORTED_RESUME`. A resume the adapter cannot apply (unknown, from another thread, already answered, expired, incomplete, malformed, stale) ends with `RUN_ERROR` and an `AGUI_*` code. New input on a thread with open interrupts ends with `RUN_ERROR` code `AGUI_INTERRUPT_PENDING`.
- Peer dependencies: `@namzu/sdk` `>=45.1.0` (was `>=44.0.0`), for the `handoff` on `turn_paused`; and `zod` `^3.23.0`, already the SDK's peer, because the adapter now builds tool definitions.
- `context.signal` in `createQuery` is the signal of the turn the request starts. It still aborts when the request is cancelled while a run reads the turn; it no longer aborts when a request whose run ended with an interrupt closes afterwards.

**What is new.** `context.interrupts.resumeHandler` and `context.interrupts.prompt` send reviews, questions and plan approvals to the client: a tool review becomes `tool_call` interrupts (answered `{ approved, editedArgs?, reason? }`), `ask_user_question` and `ToolContext.requestPause` become `input_required` interrupts, `ToolResult.handoff` a `namzu:handoff` interrupt, and any other resumable pause `namzu:paused`. Interrupt ids are minted by the adapter and recorded against the native session, turn and checkpoint in an `AGUIInterruptStore` (`interrupts.store`, in memory by default; `interrupts.ttlMs`); an answer applies once. The `frontendTools` option admits tools a client declares in `RunAgentInput.tools` as `context.frontendTools`; a request declaring tools without it is still refused with 422. See the AG-UI guide for payloads, codes and the limits of a question's wait.
