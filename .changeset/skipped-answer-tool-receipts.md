---
"@namzu/sdk": minor
---

Expose optional `skipped: true` metadata on pre-tool hook completions, recovered completed-call records and step tool results. This distinguishes a non-error skip receipt from output produced by executing a tool. Existing records without the field remain unchanged.

A skipped standalone structured-output or terminal tool now returns its receipt to the model instead of failing JSON integrity checks or settling with an unexecuted answer. Skips do not consume structured schema corrections; cancellation and iteration limits still apply. The runtime creates the marker only for pre-tool hook skips and does not infer it from receipt text or tool-authored result fields.
