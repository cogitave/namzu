---
"@namzu/sdk": minor
---

Add optional `AnswerReviewContext.requestMessages` to prose and structured
review callbacks. The built-in loop supplies an isolated copy of the SDK
provider-chain request that produced the candidate, including request-only
retrieved context and the last image-recovery dispatch. `messages` continues to
mean canonical conversation history.

The snapshot is not persisted across turns or checkpoints. Runs without a
reviewer do not copy requests for review; configured reviewers incur the memory
cost of that copy. This does not install a factual judge, authenticate arbitrary
request text, or capture provider-specific wire transformations. Hosts must
still validate source scope and integrity for their task-specific checks.
