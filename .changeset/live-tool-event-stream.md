---
"@namzu/sdk": patch
---

Forward tool starts and progress through the query event stream while an approved batch is still running. Previously these events were recorded immediately but reached the operator only after the batch finished, leaving long commands and readiness waits without a live tool row. Event-driven observation retains the existing authorization, result ordering and provider-valid batch boundaries.

Closing the stream during a live tool event cancels the captured batch and waits for executor settlement before releasing the recorder and borrowed turn resources. Tools must still honor their cancellation signal; this does not promise forced termination of arbitrary custom code.
