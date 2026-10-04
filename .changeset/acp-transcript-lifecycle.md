---
"@namzu/sdk": major
"@namzu/cli": patch
---

Extend the closed `AcpSessionUpdate` output union with `agent_thought` reasoning boundaries and `agent_message` completed messages. Exhaustive consumers must add handlers for both kinds before upgrading. Existing variants and required fields remain available. Reasoning boundaries contain no private replay payload; readable reasoning still arrives through `agent_thought_chunk`.

Message chunks carry optional actual message/turn identity and public commentary/final-answer metadata. Completed messages provide selected settled content and ordered public text parts. `turn_ended` can provide the authoritative result and its actual answer-message identity; consumers must replace the preview when a result is present, including an empty result that clears blocked output.

Keep the coarse `AcpStopReason` union and add optional exact `reason` to terminal updates and prompt responses. Current runtime guardrails/refusals map to `refused`, resource limits to `max_turns`, and parked segments retain `reason: 'paused'` under the older coarse cancellation label. Legacy aliases remain accepted. Prompt preparation cancellation returns an explicit cancellation reason even if no runtime event was produced. Streamed updates are sent in admission order and finish before the prompt response. Tool completion retains optional runtime-measured duration.

Permission questions wait for already-admitted updates and fail closed when that context was not delivered. Update errors are caught immediately, retain the first failure and release the prompt slot after flushing; failed question sends settle their pending wait. Delivery failure does not undo runtime work already recorded.

Update the CLI session-isolation regression expectations to include the exact cancellation and completion reasons; the CLI runtime is unchanged.
