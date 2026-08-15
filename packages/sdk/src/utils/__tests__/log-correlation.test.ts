import { ROOT_CONTEXT, context, trace } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getActiveSpanContext } from '../../telemetry/runtime-accessors.js'
import { createLogger } from '../log/create-logger.js'
import type { LogRecord, LogSink } from '../log/types.js'

/**
 * A log line and the span it happened inside were two unrelated facts.
 *
 * `packages/telemetry` has shipped OTel traces and metrics for a long time and
 * `LogRecord` had the fields for `traceId`/`spanId` reserved with a comment
 * saying they were not populated. So an operator with a slow run could see the
 * span tree or the log, and had no way to ask which records belong to which
 * span.
 *
 * The property that matters as much as the correlation itself: reading the
 * active context must never turn a host that has NOT configured telemetry into
 * a host that fails. `@opentelemetry/api` ships a `NoopContextManager` whose
 * `active()` returns `ROOT_CONTEXT` unconditionally, so the unconfigured case
 * costs nothing and produces no fields — and the accessor is wrapped so a
 * third-party context manager that throws cannot raise inside every log call
 * in the kernel either.
 */

function capture(): { sink: LogSink; records: LogRecord[] } {
	const records: LogRecord[] = []
	return { sink: { emit: (r) => records.push(r) }, records }
}

function logger(sink: LogSink) {
	return createLogger({
		sink,
		level: { current: 'debug' },
		resource: { 'service.name': 'namzu' },
		scope: 'test',
	})
}

describe('a record carries the span it happened inside', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('emits no correlation fields when nothing registered a tracer', () => {
		// The default, and the case that must cost nothing. Making the
		// correlation unconditional — writing empty strings rather than
		// omitting the fields — fails this.
		const { sink, records } = capture()

		logger(sink).info('nothing active')

		expect(records[0]?.traceId).toBeUndefined()
		expect(records[0]?.spanId).toBeUndefined()
		expect(records[0]?.traceFlags).toBeUndefined()
	})

	it('carries traceId, spanId and traceFlags together when a span is active', () => {
		// Deleting the spread that copies the three fields onto the record
		// fails this.
		const spanContext = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }
		vi.spyOn(trace, 'getSpan').mockReturnValue({
			spanContext: () => spanContext,
		} as unknown as ReturnType<typeof trace.getSpan>)

		const { sink, records } = capture()
		logger(sink).info('inside a span')

		expect(records[0]?.traceId).toBe(spanContext.traceId)
		expect(records[0]?.spanId).toBe(spanContext.spanId)
		expect(records[0]?.traceFlags).toBe(1)
	})

	it('never carries a trace id without its span id', () => {
		// A half-address is worse than none: it points at a trace and cannot
		// say where inside it. Changing the spread to copy only `traceId`
		// fails this.
		const spanContext = { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), traceFlags: 0 }
		vi.spyOn(trace, 'getSpan').mockReturnValue({
			spanContext: () => spanContext,
		} as unknown as ReturnType<typeof trace.getSpan>)

		const { sink, records } = capture()
		logger(sink).info('inside a span')

		const record = records[0]
		expect(
			(record?.traceId === undefined) === (record?.spanId === undefined),
			'one of the pair is present without the other',
		).toBe(true)
	})

	it('is read per record, so a span started later is picked up', () => {
		// The logger is built BEFORE any span exists. Resolving the context at
		// construction — the mistake `telemetry/metrics.ts` documents for a
		// cached meter — fails this.
		const { sink, records } = capture()
		const log = logger(sink)

		log.info('before')

		const spanContext = { traceId: 'e'.repeat(32), spanId: 'f'.repeat(16), traceFlags: 1 }
		vi.spyOn(trace, 'getSpan').mockReturnValue({
			spanContext: () => spanContext,
		} as unknown as ReturnType<typeof trace.getSpan>)
		log.info('after')

		expect(records[0]?.traceId, 'correlated before a span existed').toBeUndefined()
		expect(records[1]?.traceId).toBe(spanContext.traceId)
	})

	it('survives a context manager that throws, and still emits the record', () => {
		// A host's ContextManager is a host's object. Removing the try/catch in
		// `getActiveSpanContext` fails this — the throw reaches the caller and
		// the record is lost, turning a logging-integration bug into a run
		// failure at a call site nobody suspects can throw.
		vi.spyOn(context, 'active').mockImplementation(() => {
			throw new Error('a hostile context manager')
		})

		const { sink, records } = capture()

		expect(() => logger(sink).info('still emitted')).not.toThrow()
		expect(records).toHaveLength(1)
		expect(records[0]?.traceId).toBeUndefined()
	})

	it('reports no span for the api default, without special-casing it', () => {
		// `NoopContextManager.active()` returns ROOT_CONTEXT, which holds no
		// span — so the unconfigured answer falls out of the api's own default
		// rather than from a check here.
		expect(trace.getSpan(ROOT_CONTEXT)).toBeUndefined()
		expect(getActiveSpanContext()).toBeUndefined()
	})
})
