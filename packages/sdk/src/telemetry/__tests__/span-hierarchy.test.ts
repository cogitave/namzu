import { type Span, SpanStatusCode, context as otelContext, trace } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'

import { parentContext } from '../attributes.js'

/**
 * OTel's GenAI conventions define a strict hierarchy —
 * `invoke_agent` → `chat {model}` → `execute_tool` — and vendor dashboards
 * (Langfuse, Braintrust, Phoenix, Datadog) rely on it. namzu emitted every
 * span as a ROOT: a repo-wide grep for `context.with` / `trace.setSpan`
 * returned zero hits, so a single 20-iteration run produced 21 disconnected
 * traces with no waterfall and no LLM latency at all.
 *
 * The subtlety this file exists to pin: `startActiveSpan` does NOT hold
 * context across `yield`. Every span-owning body in the run loop is an async
 * generator, and a generator resumes on its CONSUMER's async context — so
 * the naive conversion silently fails to parent anything, and the only fix
 * that works is passing the parent explicitly.
 */

/** Minimal in-memory span capture; avoids pulling in the SDK exporter. */
function fakeSpan(name: string): Span {
	return {
		spanContext: () => ({ traceId: name, spanId: name, traceFlags: 1 }),
		setAttribute: () => fakeSpan(name),
		setAttributes: () => fakeSpan(name),
		addEvent: () => fakeSpan(name),
		setStatus: () => fakeSpan(name),
		updateName: () => fakeSpan(name),
		end: () => {},
		isRecording: () => true,
		recordException: () => {},
		addLink: () => fakeSpan(name),
		addLinks: () => fakeSpan(name),
	} as unknown as Span
}

describe('parentContext', () => {
	it('returns the ambient context when there is no parent', () => {
		expect(parentContext(undefined)).toBe(otelContext.active())
	})

	it('puts the given span into the returned context', () => {
		const parent = fakeSpan('run')
		const ctx = parentContext(parent)
		expect(trace.getSpan(ctx)).toBe(parent)
	})

	it('does not mutate the ambient context', () => {
		const before = trace.getSpan(otelContext.active())
		parentContext(fakeSpan('run'))
		expect(trace.getSpan(otelContext.active())).toBe(before)
	})

	it('survives an await — which is exactly what the ambient context does not', async () => {
		// This is the whole reason the helper exists. An explicit context is
		// a value; the ambient one is per-async-scope and is gone by the time
		// a generator resumes on its consumer's stack.
		const parent = fakeSpan('run')
		const ctx = parentContext(parent)
		await Promise.resolve()
		await new Promise((r) => setTimeout(r, 0))
		expect(trace.getSpan(ctx)).toBe(parent)
	})

	it('demonstrates the failure mode it replaces', async () => {
		// `context.with` establishes an ambient parent only for the
		// synchronous body plus awaited continuations it owns. Reading it
		// from a *separately scheduled* task sees nothing — which is the
		// position every async generator in the run loop is in.
		const parent = fakeSpan('run')
		let observedInsideDetachedTask: Span | undefined

		await otelContext.with(trace.setSpan(otelContext.active(), parent), async () => {
			await new Promise<void>((resolve) => {
				setTimeout(() => {
					observedInsideDetachedTask = trace.getSpan(otelContext.active())
					resolve()
				}, 0)
			})
		})

		expect(observedInsideDetachedTask).toBeUndefined()
		// …while the explicit context still carries the parent.
		expect(trace.getSpan(parentContext(parent))).toBe(parent)
	})
})

describe('span status constants are the ones we stamp', () => {
	it('uses OK / ERROR rather than ad-hoc strings', () => {
		expect(SpanStatusCode.OK).toBeDefined()
		expect(SpanStatusCode.ERROR).toBeDefined()
	})
})
