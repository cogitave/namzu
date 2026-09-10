---
"@namzu/cli": patch
---

Queue concurrent terminal permission requests so one agent cannot overwrite another agent’s pending approval. Show the remaining queue count, reset the consent window for each review, and settle all pending reviews on cancellation or application exit. Explicit session-wide approval includes queued reviews.
