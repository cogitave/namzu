---
'@namzu/sdk': minor
'@namzu/cli': patch
'@namzu/deepseek': major
'@namzu/anthropic': major
---

Persist provider-native reasoning state with the exact provider, model, and fallback-chain member that produced it. Same-route sessions now replay native reasoning after restart, `/resume`, and `/fork`; a model, provider, or member switch keeps portable assistant/tool history without sending foreign native reasoning metadata.

`@namzu/sdk` adds `ProviderRoute`, `AssistantMessageSource`, optional assistant source/replay fields, and the provider request/stream/response plumbing. Fallback and forced-final turns now attribute provenance and cost to the member that actually answered.

`@namzu/cli` preserves and validates the additive assistant source shape in stateless and durable history.

**What breaks in the drivers:** hand-built assistant reasoning and histories written by earlier versions do not carry a validated route-bound replay envelope, so they are no longer emitted as native `reasoning_content` or signed thinking. Their portable assistant text and tool exchanges remain available, but an upstream that requires native metadata for an old tool continuation may refuse that request; compact or start a fresh conversation before continuing such legacy history. Preserve the complete assistant message returned by new runs, including `source.replayState`. Direct callers of the exported DeepSeek `toDeepSeekMessages` converter must also pass the target `ProviderRoute` as its second argument.
