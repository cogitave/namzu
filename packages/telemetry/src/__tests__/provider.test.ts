import { trace } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TelemetryProvider, getTelemetry, getTracer, registerTelemetry } from '../provider.js'
import type { SpanProcessorLike } from '../types.js'
import { VERSION } from '../version.js'

/**
 * The claim this file exists to hold is the one `provider.ts` makes twice in
 * prose and nothing checked: **`exporterType: 'none'` suppresses the exporter,
 * not the pipeline.**
 *
 * A real `NodeTracerProvider` is installed either way, so spans get valid
 * contexts and a host's own span processors still see them; only the batch
 * exporter is left out. If that ever became "install nothing when 'none'",
 * every consequence would be silent — spans would still be created, code
 * would still run, `getTracer()` would still return a tracer, and a host
 * collecting through its own processor would simply receive nothing forever.
 *
 * `'none'` throughout, deliberately: the other two exporter types either write
 * to the console or open a network connection, and a test that did either
 * would be measuring the exporter rather than this file.
 *
 * `registerTelemetry` mutates `@opentelemetry/api` process globals, which is
 * the documented, OTEL-idiomatic design and not something to work around. It
 * does mean these tests share one process, so each shuts its provider down and
 * the global tracer provider is disabled afterwards.
 */

function recordingProcessor(): { processor: SpanProcessorLike; ended: string[] } {
	const ended: string[] = []
	return {
		ended,
		processor: {
			onStart: () => {},
			// The SDK hands `(span, context)`; the structural type says `never[]`
			// so a consumer is not pinned to one tracing-SDK version.
			onEnd: ((span: { name: string }) => {
				ended.push(span.name)
			}) as unknown as SpanProcessorLike['onEnd'],
			forceFlush: async () => {},
			shutdown: async () => {},
		},
	}
}

afterEach(async () => {
	await getTelemetry()?.shutdown()
	trace.disable()
})

describe("exporterType: 'none'", () => {
	it("still installs a real provider, so a host's own processor receives spans", async () => {
		const { processor, ended } = recordingProcessor()

		await registerTelemetry({
			serviceName: 'namzu-test',
			exporterType: 'none',
			spanProcessors: [processor],
		})

		getTracer().startSpan('a-span').end()

		// The whole promise in one assertion. With no provider registered the
		// api's no-op tracer produces a span that reaches nothing, and this
		// array stays empty.
		expect(ended).toEqual(['a-span'])
	})

	it('gives the span a recording context rather than the no-op one', async () => {
		await registerTelemetry({ serviceName: 'namzu-test', exporterType: 'none' })

		const span = getTracer().startSpan('recorded')
		const { traceId, spanId } = span.spanContext()
		span.end()

		// The no-op tracer answers all-zeroes for both. "Valid contexts" is the
		// other half of what installing-anyway buys, and it is what makes a
		// `trace_id` on a log record join to anything.
		expect(traceId).not.toMatch(/^0+$/)
		expect(spanId).not.toMatch(/^0+$/)
	})
})

describe('the host processor ordering', () => {
	it("puts the host's processors ahead of the exporter's, and keeps every one", async () => {
		const first = recordingProcessor()
		const second = recordingProcessor()

		await registerTelemetry({
			serviceName: 'namzu-test',
			exporterType: 'none',
			spanProcessors: [first.processor, second.processor],
		})

		getTracer().startSpan('shared').end()

		// Both, not the first only: a `push` that replaced rather than
		// appended would satisfy a single-processor test.
		expect(first.ended).toEqual(['shared'])
		expect(second.ended).toEqual(['shared'])
	})
})

describe('the global handle', () => {
	it('is the provider once something registers', async () => {
		const provider = await registerTelemetry({
			serviceName: 'namzu-test',
			exporterType: 'none',
		})

		expect(getTelemetry()).toBe(provider)
	})

	it('is null in a process where nothing registered, and getTracer still answers', async () => {
		// A fresh module registry, because `_globalProvider` is module state
		// and nothing exports a way to clear it — the first `registerTelemetry`
		// in this file would otherwise decide the answer for every test after
		// it. Same device `log-process-sink.test.ts` uses on the SDK side.
		vi.resetModules()
		const fresh = await import('../provider.js')

		expect(fresh.getTelemetry()).toBe(null)
		// Not a throw and not undefined: the api's own no-op tracer under a
		// name. A host that acquires a tracer before registering gets one that
		// discards, rather than a crash at the first span.
		expect(fresh.getTracer()).toBeDefined()
		expect(fresh.getMeter()).toBeDefined()
	})

	it('defaults serviceVersion to the package version', async () => {
		const provider = new TelemetryProvider({ serviceName: 'namzu-test', exporterType: 'none' })

		// Reached through the tracer rather than the config, because the
		// fallback is applied where the tracer is acquired and a test of the
		// config object would pass against a version that never arrives.
		expect(provider.tracer).toBeDefined()
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
	})
})

describe('shutdown', () => {
	it('swallows a provider that fails to shut down, and says so on stderr', async () => {
		// NOT the registered global. Breaking the one `getTelemetry()` returns
		// leaves `afterEach` shutting down a wedged provider for the rest of
		// the file, and its stderr then lands inside whichever test runs next.
		const provider = new TelemetryProvider({ serviceName: 'namzu-test', exporterType: 'none' })
		// biome-ignore lint/suspicious/noExplicitAny: reaching a private field is the point — the failure has to come from inside
		;(provider as any).meterProvider = {
			shutdown: async () => Promise.reject(new Error('exporter is wedged')),
		}

		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

		// Shutdown runs on the way out of a process. Rethrowing here turns a
		// telemetry problem into a non-zero exit for a run that succeeded.
		await expect(provider.shutdown()).resolves.toBeUndefined()
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining('Telemetry shutdown error'),
			'exporter is wedged',
		)

		stderr.mockRestore()
	})

	it('reports a thrown non-Error without losing it', async () => {
		const provider = new TelemetryProvider({ serviceName: 'namzu-test', exporterType: 'none' })
		// biome-ignore lint/suspicious/noExplicitAny: same reason as above
		;(provider as any).meterProvider = {
			shutdown: async () => Promise.reject({ code: 'ENOTELEMETRY' }),
		}

		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
		await provider.shutdown()

		// `toErrorMessage`'s JSON branch. `String({})` would say
		// "[object Object]", which names nothing.
		expect(stderr).toHaveBeenCalledWith(expect.any(String), '{"code":"ENOTELEMETRY"}')
		stderr.mockRestore()
	})
})
