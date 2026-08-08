---
'@namzu/sdk': major
'@namzu/cli': minor
---

**A declared provider chain now falls over.** It was validated, doctor-checked and capability-refused, and nothing ever used it — `providers[1..N]` were decoration. They are not any more.

**If you have one provider, nothing changes.** A one-member chain composes to exactly the previous behaviour, byte for byte, and emits no new events.

**If you have declared fallbacks, they will now be used.** Your primary still gets its full retry budget first, and a `Retry-After` is still honoured before anything moves — but a rejected credential, a missing model, an exhausted rate limit or an outage now advances to the next member instead of failing the turn. The scope is the turn: your next message starts at the primary again.

namzu will not fall over on a failure that is a property of your *request* — a context overflow, a rejected request, a refusal — because the identical request fails identically on the next provider.

**Every swap is announced.** A new `provider_fallback` run event, `provider.fallback` on the wire, and a transcript line in the CLI naming the member that failed, why, and the member now serving.

**That announcement is why this is a major.** `RunEvent` and `StreamEventType` are wider, so a consumer that switches exhaustively over either — with no `default` and a `never` check — stops compiling until it adds an arm. That is not a hypothetical: the SDK's own A2A mapper, SSE mapper and run reporter all do it, and the compiler named all three in this change, exactly as it did in 12.0.0 when `plan_completed` and `plan_failed` were added and that release went out as a major for this reason. Widening a union a consumer reads is a break in this repo whatever the ecosystem convention is; the fix is one `case` per new member.

**A fallover loses the prompt cache**, so the rest of the turn re-reads your whole context at full price. That is the largest single cost of running a chain and it is worth ordering the chain accordingly.

**Breaking for one combination, and only that one:** `query()` now throws `invalid_config` when `pricing` is passed together with a chain of more than one member. One pricing table cannot price two members, so the reported total — and `runConfig.costLimitUsd`, which is enforced from it — would be wrong by an unbounded margin and silently so. To keep pricing, declare one member; to keep the chain, drop `pricing`. No existing caller can hit this, because the chain is only reachable through the new `fallbackProviders` option.

New in `@namzu/sdk`: `withProviderFallback`, `ProviderChainMember`, `WithProviderFallbackOptions`, `QueryParams.fallbackProviders`, `StreamChunk.fallback`, `ProviderFallbackNotice`.

A fallback with no credential is left out of the chain and named at launch, rather than discovered as a 401 on the day your primary goes down. Sub-agents resolve their provider independently and do not inherit the chain.
