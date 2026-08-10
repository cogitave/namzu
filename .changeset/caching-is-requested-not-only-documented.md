---
'@namzu/bedrock': major
---

Prompt caching is now requested, not only documented

The provider page said caching was requested when the caller set `cacheControl`, with breakpoints after the tool schemas, after the static system text, and after the last message. None of it was true. This wire enables caching with an explicit `cachePoint` block inside the request, and the driver emitted none — while mapping `cacheReadInputTokenCount` and `cacheWriteInputTokenCount` correctly, so the usage came back a truthful zero and a caller could not tell "caching does not help this workload" from "caching was never asked for". Prompt caching is the largest single cost lever on a long run, and this one was off with the switch documented as on.

The driver now emits the three cache points the page describes: after the last tool schema, after the last system message tagged `cacheHint: 'cache'`, and after the last content block of the last message. The system point is placed after the *static* block rather than at the end of the array — a marker after the per-run dynamic text would cache a prefix that changes every run, so every read would miss and every write would be billed.

**Why this is major even though no exported type changed.** Your requests change shape without you changing a line. The runtime sets `cacheControl` on every iteration, so any caller on a model Anthropic serves through Converse starts sending cache points as soon as they take this version. Expect cache-write tokens on the first turn of a stable prefix — they are priced above ordinary input — and cache reads, priced below it, on the turns after. The steady state is cheaper; the first turn is not. There is no per-driver switch to decline: a request without `cacheControl` is uncached, and the runtime supplies it, so declining means not taking this version.

**Only for the models Anthropic serves on this wire.** Converse carries several vendors and prompt caching is a property of the models on it, not of the wire, so a cache point sent to a model that does not accept one is rejected outright — the whole request, not the caching. The gate reuses `isAnthropicServedModel`, which this driver already uses to pick a tool-schema dialect for the same reason. A model outside the gate sends exactly the bytes it sends today and `cacheControl` has no effect on it; the provider page now says so.

Two documentation claims on the same page were also false and are corrected: the capability snapshot reported `supportsVision: true` where the package exports `false`, and the paragraph beside it described images travelling as raw bytes. This driver maps no image content at all — a user attachment does not reach the model, and an image in a tool result becomes a named placeholder.
