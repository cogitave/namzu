---
'@namzu/openrouter': patch
---

Prompt caching now places explicit breakpoints instead of sending a top-level
`cache_control: { type: 'auto' }`, a value OpenRouter does not define (its
top-level field takes `{ type: 'ephemeral' }` and puts the breakpoint on the
last cacheable block — with request-only context at the tail, the part the next
request replaces).

For `anthropic/`, `google/gemini` and `qwen/` models, the models OpenRouter
documents as needing explicit breakpoints, a cache request marks the last
static system message and the last non-system message before request-only
context, each inside a content part (a string becomes one text part). A system
message directly before the context is the step's guidance, which changes from
step to step, so it is passed over rather than marked. Other models, which
OpenRouter documents as caching automatically, are sent no marker and keep
their plain string content.
