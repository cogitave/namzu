---
'@namzu/sdk': major
---

Tool retry now backs off with full jitter instead of re-running immediately

The in-loop tool retry had no delay at all: a failed call went straight back
into execution, as many times as its budget allowed. The failures worth
retrying are exactly the ones an immediate retry makes worse — a rate limit
answers the second call faster than it recovers, a contended lock is still
held — so the loop was most likely to prolong the condition it was retrying
against.

Attempts are now spaced on the same curve the provider path has always used,
from the same implementation: exponential from `initialDelayMs`, doubling per
attempt, capped at `maxDelayMs`, each wait drawn uniformly from `[0, curve]`.
The jitter matters here specifically because a batch of the model's parallel
calls executes together, so calls that fail together against one endpoint
would be resynchronised by any fixed wait.

**This is a changed default, which is why it is major.** A retryable tool call
that previously re-ran instantly now waits — 500ms doubling to a 16s ceiling
before jitter — so any host whose tools declare `maxRetries` sees new latency
on the retry path. Nothing else waits: a tool that never opted into retrying,
which is the shipped default of `maxRetries: 0`, never reaches this code.

To keep the old timing exactly, set the wait to zero:

```ts
query({ toolRetryBackoff: { initialDelayMs: 0, maxDelayMs: 0 } })
```

`toolRetryBackoff` is new on `query()` and on `ReactiveAgentConfig`, and takes
a partial `{ initialDelayMs?, maxDelayMs? }`.

A Stop arriving during a wait now ends the retrying and hands the model the
failure already in hand, rather than leaving that `tool_use` unanswered.
