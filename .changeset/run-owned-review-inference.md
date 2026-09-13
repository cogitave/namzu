---
"@namzu/sdk": minor
---

Add optional `AnswerReviewContext.generateText` to prose and structured output
review. A host callback can make one bounded, tool-free inference using the
run's provider/fallback chain, selected step model and effort. It accepts the
existing `PreparationTextRequest` shape and returns `PreparationTextResult`.

Usage contributes to the owning run and token budget without changing the
candidate step's usage or provenance. Await the call before returning a verdict;
completion, error and cancellation revoke the capability. Only explicitly
supplied text is sent, and no automatic model judge is installed. Hosts must
still validate generated judgments and authenticate task-specific source data.
