---
'@namzu/sdk': patch
---

The question a run asked and the answer that resolved it match on the same key

`user_question_asked` carried a `question_id` and `user_question_answered` did not, so a client that keyed on the question id — the natural key, since it is what routes an answer back on resume — could not match the two halves without also having stored the checkpoint id. The answered event now carries it whenever the resolution named one.

Twelve event mappings across the SSE and agent-to-agent bridges shipped with no test: the nine event kinds added since those mappers were first written, plus the failure-classification and message-role paths. A wire transform with no test is a contract nobody checked — the field names are what a remote consumer parses, and the transforms return `Record<string, unknown>`, so renaming one is a break type-checking cannot see.
