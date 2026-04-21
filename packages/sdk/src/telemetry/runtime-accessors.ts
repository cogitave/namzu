// SDK-internal tracer/meter readers. Not re-exported by the root barrel.
//
// These wrap `@opentelemetry/api` globals so SDK internal call sites
// (runtime/query, runtime/query/iteration, registry/tool/execute) have a
// single place to resolve the active tracer/meter. When `@namzu/telemetry`
// is registered, its `registerTelemetry()` mutates the api globals and
// these readers pick up the real providers; without registration, they
// return the no-op defaults and every span/meter write is silently
// discarded — standard OTEL library behavior.

import { type Tracer, trace } from '@opentelemetry/api'

export function getTracer(): Tracer {
	return trace.getTracer('namzu')
}
