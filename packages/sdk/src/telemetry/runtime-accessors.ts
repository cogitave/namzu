// SDK-internal tracer/meter readers. Not re-exported by the root barrel.
//
// These wrap `@opentelemetry/api` globals so SDK internal call sites
// (runtime/query, runtime/query/iteration, registry/tool/execute) have a
// single place to resolve the active tracer/meter. When `@namzu/telemetry`
// is registered, its `registerTelemetry()` mutates the api globals and
// these readers pick up the real providers; without registration, they
// return the no-op defaults and every span/meter write is silently
// discarded — standard OTEL library behavior.

import { type SpanContext, type Tracer, context, trace } from '@opentelemetry/api'

export function getTracer(): Tracer {
	return trace.getTracer('namzu')
}

/**
 * The active span's context, read fresh on every call — nothing here is
 * ever cached. `utils/log/create-logger.ts`'s `emit` calls this once per
 * ACCEPTED record (after the level check, never before) so a logger built
 * before any tracer provider registers still picks up spans started after
 * registration. Caching this at logger construction would repeat the exact
 * mistake `telemetry/metrics.ts` documents for a meter: a bag that
 * captured the no-op instance once stayed no-op for the rest of the
 * process even after a real provider registered later.
 *
 * `undefined` whenever nothing is active — the DEFAULT, not an edge case
 * this function has to detect. `@opentelemetry/api` ships a
 * `NoopContextManager` until something registers a real one
 * (`@namzu/telemetry`'s `registerTelemetry` does, via
 * `NodeTracerProvider.register()`), and that default's `active()`
 * unconditionally returns `ROOT_CONTEXT` — it does not even remember what a
 * caller set with `context.with()`. So a host that never configures
 * telemetry gets `undefined` here on every call, for free, with nothing in
 * this function special-casing "telemetry not configured": that behaviour
 * is the api's own default, not a check performed here. Which is also why
 * this can only ever ADD information to a record — reading the active
 * context can never make an unconfigured host fail a check that would
 * otherwise pass (`an-optional-dependency-may-not-degrade-a-check`, in
 * reverse).
 */
export function getActiveSpanContext(): SpanContext | undefined {
	// Wrapped for the same reason `createLogger` wraps `sink.emit`: everything
	// this touches past the api boundary is a HOST's object. A third-party
	// `ContextManager` whose `active()` throws would otherwise raise that
	// exception inside every log call in the kernel — turning a logging
	// integration bug into a run failure, at a call site nobody reading it
	// would suspect of being able to throw.
	//
	// Swallowed rather than reported, unlike a dropped record: this cannot
	// lose a record. The record still emits, just without correlation, which
	// is exactly the state of every host that has not configured telemetry at
	// all. Degrading the correlation is not degrading the check.
	try {
		return trace.getSpan(context.active())?.spanContext()
	} catch {
		return undefined
	}
}
