---
'@namzu/anthropic': minor
'@namzu/sdk': minor
'@namzu/cli': patch
---

Anthropic driver gaps: paused hosted searches, side-call parameters, the model menu, cache diagnostics and usage.

`@namzu/anthropic` (minor): a hosted search the service pauses (`pause_turn`) now continues, up to five times within one turn, instead of failing it; a turn still paused after five continuations fails as unfinished. On the vendor's own host the driver sends `diagnostics.previous_message_id` and reads the miss reason into `TokenUsage.cacheMiss`; nothing is sent to a compatible or third-party endpoint. Usage now reads `server_tool_use.web_search_requests`, `service_tier` and `inference_geo`. `OFFLINE_MODEL_CATALOGUE` no longer lists `claude-opus-4-1-20250805` (retired) or `claude-sonnet-4-5-20250929` (retires 2026-11-30) and lists `claude-sonnet-5-5` and `claude-opus-4-8`; both removed ids still work for a caller that names them until the vendor stops serving them.

`@namzu/sdk` (minor): `TokenUsage` gains `webSearchRequests` (summed), `serviceTier`, `inferenceGeo` and `cacheMiss`; `ModelPricing.webSearchCostPer1000` prices hosted searches (Anthropic: $10 per 1,000), and tokens served on the `priority` or `batch` tier are reported as unpriced rather than at the standard rate, since the vendor publishes no per-token price for them. A cost limit on a priority-tier account is refused as unmeasurable until a price is published. `token_usage_updated` gains `cacheMiss`. Compaction summaries, their verifier and the auto-review classifier now resend without `temperature` when a model refuses it, as the turn already did; the turn's repair also recognises a refused `top_k`.

`@namzu/cli` (patch): forwards `cacheMiss` on the usage item; shows nothing new.
