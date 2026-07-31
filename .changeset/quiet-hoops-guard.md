---
'@namzu/sdk': minor
---

Add input/output guardrails to `query()`.

namzu had three gates on tool calls — probe veto, `VerificationGate`, HITL
review — and all three point the same way: they protect the world from the
agent. Nothing protected the user from the agent's own output, and nothing
looked at the prompt before a run started.

- `inputGuardrails` run before the first model call. A block settles the run
  as `input_guardrail` having spent nothing.
- `outputGuardrails` run against the final result. A block settles as
  `output_guardrail`; a `rewrite` replaces the text, so a redaction policy
  can clean an answer instead of discarding it. Rewrites compose.
- A guardrail that throws **fails closed** — deliberately the opposite of
  `stopWhen`. A broken halt predicate should not kill a healthy run; a broken
  safety check must not wave content through.
- New `guardrail_triggered` run event (wire: `guardrail.triggered`).
- Presets: `secretRedactionGuardrail` (prefix-anchored credential patterns,
  redact or block) and `promptInjectionGuardrail` (partial, by design).

These gate the result, not the stream: `text_delta` events have already
reached the host, so a rewrite arrives as a correction alongside the event.
