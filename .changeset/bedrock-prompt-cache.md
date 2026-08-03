---
'@namzu/bedrock': minor
---

Prompt caching is now requested, not just measured.

The driver read the cache-hit and cache-write counters off every response
and never asked for caching, so both were permanently zero: the entire
static prefix — tool schemas, system instructions, the whole conversation
so far — was re-sent and re-billed at full rate on every single turn of
every run. Nothing failed, which is why it went unnoticed; it was purely
money and latency.

A breakpoint on this wire is a content BLOCK rather than an annotation on a
neighbouring one: everything ahead of it in render order is cached. Render
order is tools → system → messages, so the driver places one at the tail of
each section, and each later breakpoint covers everything before it:

- after the tool schemas, which render first and are the largest static
  segment — this keeps them cached even when the conversation below changes
  every turn;
- after the last system block the runtime tagged as static, NOT at the end
  of the system section. The per-run dynamic tail comes after that tag; a
  breakpoint over text that changes every run invalidates the entry each
  turn and bills a cache write for nothing;
- after the last message, so the next iteration — which only appends —
  reads all the prior history at cache rates.

Three breakpoints, one under the wire's limit of four. None are placed
unless the caller sets `cacheControl`, and none are placed over system
text with nothing static in it or on a message with no content.
