---
type: Reference
title: Prompt cache routing on the subscription route
description: How a conversation's requests name one cache and keep their opening bytes identical.
resource: packages/providers/openai/src/codex.ts
tags: [sdk, providers, cache, codex]
---

# Prompt cache routing on the subscription route

A provider reuses the start of a request it has already read, but only when the
next request begins with the same bytes and is sent to the same cache. Two
things decide that on the OpenAI subscription (Codex) route.

## One name for the conversation

`ChatCompletionParams.cacheKey` is a stable name for the conversation. The
query loop sets it to the session id on every request it makes for the turn,
including the closing summary. The Codex driver sends it as `prompt_cache_key`
in the body and as the `session_id` header. A caller that sets no key sends
neither, and a driver with no cache-routing field ignores it.

## What opens the request

`instructions` carries only the system messages that open the message list. The
query loop places a step's preamble (changing guidance, skills, turn notes) as a
system message after the history. It stays there, sent as a `developer` message
in `input`, so the opening bytes (instructions, tools, earlier history) are the
same from one request to the next and only the tail differs. Before this, every
system message was joined into `instructions`, so a preamble that changed each
step changed the first bytes of the request and no request shared a cache
prefix with the one before it.

Not yet confirmed against the live subscription backend: that it accepts a `developer`-role item in `input` and the `session_id` header. Confirm with one real round trip before a release.

The turn record already keeps the cached share of each call's prompt tokens
(`cachedTokens` on the usage and the `cache read tokens` span attribute); read
it to see whether a conversation is hitting its cache.
