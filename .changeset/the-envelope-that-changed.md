---
'@namzu/sdk': minor
---

New durable run event `request_envelope`, carrying `{ iteration, model, systemPrompt, toolNames, toolSchemaDigest }`. Emitted only when the tuple differs from the last one the run recorded.

`run_started` records a system prompt once, and tool schemas never reached the transcript at all — while `prepareStep` rewrites the system text, narrows the tool list or swaps the model between iterations, and a step's skills ride an ephemeral trailing system message. So everything about *what* was asked could change, and the durable record said it had not.

**Only on a change**, and the suppression is not a performance detail: copying an unchanged system prompt into every iteration is the fastest way to make a transcript too large to read. A run whose request never varies emits exactly one.

The digest is over the tool **schemas**, sorted, not their names. A name list cannot see a tool whose schema body moved while its name did not — the change most likely to alter what the model does and least likely to be noticed.

Declined by both wire mappers: a live consumer can already read the prompt off the stream, the payload is the largest the kernel emits, and what this runtime asked its own model is not a fact about the task an A2A peer is tracking. The run reporter logs it at `debug`.
