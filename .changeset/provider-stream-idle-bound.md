---
'@namzu/sdk': major
'@namzu/openrouter': patch
---

Bound provider stream silence, including query-owned advisory calls and
RouterAgent routing decisions, to five minutes by default and abort the stalled
provider transport, with network-classified retry and fallback recovery where
those policies apply. This changes the previous default, under which a provider
iterator could remain silent forever. Set `streamIdleTimeoutMs: 0` on the run or
agent config to keep the old unbounded behavior, or set a positive millisecond
value to choose a different bound.

Queries whose caller signal is already aborted now settle as cancelled before
starting provider, provider-metadata, or tool work. A later cancellation also
settles while an optional context-window resolver remains pending, even when
that resolver ignores its signal. With no caller cancellation, `timeoutMs`
bounds the optional metadata lookup, aborts its private transport signal, and
falls back to the static context-window table instead of blocking the run.

The OpenRouter context-window lookup now forwards cancellation to its model-list
transport. Only fulfilled listings are cached, so cancelling one concurrent
query cannot abort another query's shared metadata request or force that query
onto the static context-window table.
