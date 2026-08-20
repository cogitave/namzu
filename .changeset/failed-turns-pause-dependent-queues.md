---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Expose unsupported document inputs through the public `capability_warning` run event before provider settlement. Consumers handling that event must accept the new `documents` capability value.

Render provider capability warnings in the interactive transcript, and pause already-queued follow-ups after a failed or abnormally stopped human turn until the operator submits a continuation or successfully changes provider/model.
