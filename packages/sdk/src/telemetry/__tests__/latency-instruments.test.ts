import { type Attributes, type Meter, metrics } from '@opentelemetry/api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { recordTimeToFirstToken, recordToolCall, resetRuntimeMetrics } from '../metrics.js'

/**
 * namzu streams, so perceived latency is dominated by time to first token
 * — and the only latency histogram measured the whole request, which
 * cannot distinguish a fast-first-token long generation from a stalled
 * one. No host could recover the difference from namzu's data in any form.
 *
 * The tool half is milder: the wall clock WAS measured and emitted per
 * call on `tool_completed`, so a p95 was computable from events. What was
 * missing was the instrument — with the value already in scope one frame
 * above the call site.
 */

interface Written {
	instrument: string
	value: number
	attributes: Attributes
}

function fakeMeterProvider(written: Written[]) {
	const instrument = (name: string) => ({
		add: (value: number, attributes: Attributes = {}) =>
			written.push({ instrument: name, value, attributes }),
		record: (value: number, attributes: Attributes = {}) =>
			written.push({ instrument: name, value, attributes }),
	})
	const meter = {
		createCounter: (name: string) => instrument(name),
		createHistogram: (name: string) => instrument(name),
		createUpDownCounter: (name: string) => instrument(name),
		createObservableGauge: (name: string) => instrument(name),
		createObservableCounter: (name: string) => instrument(name),
		createObservableUpDownCounter: (name: string) => instrument(name),
		addBatchObservableCallback: () => {},
		removeBatchObservableCallback: () => {},
	} as unknown as Meter
	return { getMeter: () => meter }
}

let written: Written[]

beforeEach(() => {
	written = []
	resetRuntimeMetrics()
	metrics.setGlobalMeterProvider(fakeMeterProvider(written))
})

afterEach(() => {
	metrics.disable()
	resetRuntimeMetrics()
})

const writesTo = (name: string) => written.filter((w) => w.instrument === name)

const TTFT = 'gen_ai.client.time_to_first_token'
const TOOL_DURATION = 'gen_ai.tool.call.duration'

describe('time to first token', () => {
	it('is recorded in seconds, like every other duration here', async () => {
		recordTimeToFirstToken('m-1', 250)

		// A histogram that silently used milliseconds would look right and
		// aggregate wrong next to the request-duration one.
		expect(writesTo(TTFT)[0]?.value).toBeCloseTo(0.25)
	})

	it('is keyed by model, so a slow model is attributable', () => {
		recordTimeToFirstToken('fast', 100)
		recordTimeToFirstToken('slow', 4_000)

		expect(writesTo(TTFT).map((w) => w.attributes['gen_ai.request.model'])).toEqual([
			'fast',
			'slow',
		])
	})

	it('is a separate instrument from the whole-request duration', () => {
		// The point of the gap: one number cannot answer both questions.
		recordTimeToFirstToken('m-1', 250)
		expect(writesTo('gen_ai.client.operation.duration')).toHaveLength(0)
		expect(writesTo(TTFT)).toHaveLength(1)
	})
})

describe('tool duration', () => {
	it('is recorded when the caller supplies it', () => {
		recordToolCall('read', true, undefined, 1_500)
		expect(writesTo(TOOL_DURATION)[0]?.value).toBeCloseTo(1.5)
	})

	it('shares the attributes of the count, so slow and failing join up', () => {
		recordToolCall('fetch', false, 'ETIMEDOUT', 2_000)

		expect(writesTo(TOOL_DURATION)[0]?.attributes).toMatchObject({
			'gen_ai.tool.name': 'fetch',
			'namzu.tool.success': false,
			'namzu.tool.error': 'ETIMEDOUT',
		})
	})

	it('still counts the call when no duration is supplied', () => {
		recordToolCall('read', true)

		expect(writesTo('gen_ai.tool.call.count')).toHaveLength(1)
		// No duration write rather than a fabricated zero, which would drag
		// every percentile down.
		expect(writesTo(TOOL_DURATION)).toHaveLength(0)
	})

	it('counts and times in one call, not two that could diverge', () => {
		recordToolCall('read', true, undefined, 900)

		expect(writesTo('gen_ai.tool.call.count')).toHaveLength(1)
		expect(writesTo(TOOL_DURATION)).toHaveLength(1)
	})
})
