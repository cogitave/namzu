---
'@namzu/sdk': major
---

Use Topic terminology across the public lifecycle authority and its rejection shapes.

**What breaks:** `TopicManager`, `InMemoryTopicStore`, `AgentManager`, and the handoff helpers now reject with `TopicArchivedError`, `TopicNotEmptyError`, and `StaleTopicError`. Their `error.name`, message, JSON serialization, and structured details use Topic vocabulary; replace `details.threadId` with `details.topicId` and branch on the new classes exported from `@namzu/sdk`.

Inject the lifecycle authority through the canonical `topicManager` dependency key. The deprecated `threadManager` key remains accepted for a migration window, but supplying two different manager instances is now refused instead of choosing one implicitly.
