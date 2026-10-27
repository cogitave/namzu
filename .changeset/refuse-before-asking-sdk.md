---
'@namzu/sdk': minor
---

A tool definition can now declare `refuseBeforeReview(input, context)`, an optional hook the executor asks while preparing a batch, after the arguments are valid and before a reviewer is asked. Returning `{ error, facts? }` answers the model with that refusal and shows nobody a question. `edit` and `write` use it: a file that changed on disk after the session read it is refused up front, so no approval is requested for a change that would be refused on approval. Nothing changes for a tool that does not declare it; `execute` keeps its own checks.
