---
type: Reference
title: Prompt cache lifetime
description: How long a provider keeps the prompt cache, how a call reports it, the CacheClock that tracks when it lapses, and the provider option that picks the lifetime.
resource: packages/sdk/src/runtime/cache-clock.ts
tags: [sdk, providers, caching]
status: stable
---

# Prompt cache lifetime

A provider that caches prompts keeps the cache for a limited time. The SDK
reports that time as a fact about each call and never guesses it.

## What a call reports

- `TokenUsage.cacheTtlMs` is the lifetime, in milliseconds, of the cache the
  call used. It belongs to one call: summing usage drops it, and the frames of
  one streamed call keep the latest value. Absent means the driver does not
  report a lifetime.
- `TokenUsage.cacheWriteTtlTokens` splits the cache-write tokens by the lifetime
  they were written with (`fiveMin`, `oneHour`). It is present only when the
  provider breaks the count down.
- `CacheControl.ttl` (`'5m'` or `'1h'`) asks for a lifetime on one request.
- `ProviderCapabilities.cacheTtl` lists the lifetimes a driver can be asked for.
  Absent means the driver offers none.
- The `token_usage_updated` event carries `cache: { ttlMs, touched }` when the
  call reported a lifetime. `touched` is true when the call read or wrote cache.

## CacheClock

`CacheClock` tracks when the conversation's cache lapses. `record(usage, at)`
takes one finished call's usage; a call without `cacheTtlMs` clears the clock,
so nothing acts on a lifetime nobody stated. `state` returns a
`CacheClockState` (`lastActivityAt`, `ttlMs`, `expiresAt`, where `expiresAt` is
`null` when the call touched no cache). `warm(now)` says whether the cache is
still alive, `dueAt(fraction)` gives the moment a fraction of its life has
passed, and `reset()` forgets everything. It holds no timers; the caller passes
the time.

## Choosing the lifetime

`@namzu/anthropic` and `@namzu/bedrock` take `promptCacheTtl: '5m' | '1h'`
(default `'5m'`). Every breakpoint in a request carries the same lifetime, and
`cacheControl.ttl` overrides it for one call. The longer lifetime costs more per
cache write. Bedrock sends `'1h'` only for Claude 4.5 and later models; any other
model keeps the default. The CLI setting is `promptCacheTtl`, described in
[Context and compaction](../cli/context-and-compaction.md).
