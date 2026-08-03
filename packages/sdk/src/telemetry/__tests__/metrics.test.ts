import { type Attributes, type Meter, metrics } from '@opentelemetry/api'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	recordModelDuration,
	recordRunDuration,
	recordTokenUsage,
	recordToolCall,
	resetRuntimeMetrics,
} from '../metrics.js'

/**
 * Metrics lived in a bag a host was expected to construct, and nothing in
 * the workspace ever constructed one — so the runtime emitted spans and not
 * a single measurement. Worse, the bag bound its instruments eagerly: one
 * built before the provider was installed captured the no-op meter and
 * discarded every write for the rest of its life, silently, from one line
 * of call order.
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

const attributesOf = (name: string) => written.filter((w) => w.instrument === name)

describe('token usage', () => {
	it('records every kind under ONE metric, split by type', () => {
		recordTokenUsage('m', {
			promptTokens: 100,
			completionTokens: 20,
			cachedTokens: 500,
			cacheWriteTokens: 40,
		})

		const writes = attributesOf('gen_ai.client.token.usage')
		// It was two metrics under two names, the second invented — so a
		// dashboard aggregating the conventional name saw input only.
		expect(writes).toHaveLength(4)
		expect(new Set(writes.map((w) => w.attributes['gen_ai.token.type']))).toEqual(
			new Set(['input', 'output', 'cache_read', 'cache_write']),
		)
		expect(writes.reduce((sum, w) => sum + w.value, 0)).toBe(660)
	})

	it('records cache traffic as its own types rather than folding it into input', () => {
		recordTokenUsage('m', { promptTokens: 10, completionTokens: 0, cachedTokens: 900 })

		const input = attributesOf('gen_ai.client.token.usage').find(
			(w) => w.attributes['gen_ai.token.type'] === 'input',
		)
		// A read bills at a fraction of the input rate; summing them would
		// make the total unable to explain a bill.
		expect(input?.value).toBe(10)
	})

	it('writes nothing for a kind that was zero', () => {
		recordTokenUsage('m', { promptTokens: 5, completionTokens: 0 })
		expect(attributesOf('gen_ai.client.token.usage')).toHaveLength(1)
	})

	it('carries the model on every write', () => {
		recordTokenUsage('some-model', { promptTokens: 1, completionTokens: 1 })
		for (const write of attributesOf('gen_ai.client.token.usage')) {
			expect(write.attributes['gen_ai.request.model']).toBe('some-model')
		}
	})
})

describe('tool calls', () => {
	it('records the outcome and why it failed', () => {
		recordToolCall('read', false, 'ENOENT')
		const write = attributesOf('gen_ai.tool.call.count')[0]
		expect(write?.attributes['gen_ai.tool.name']).toBe('read')
		expect(write?.attributes['namzu.tool.success']).toBe(false)
		// A flat success rate cannot separate a broken tool from one whose
		// input the model keeps getting wrong.
		expect(write?.attributes['namzu.tool.error']).toBe('ENOENT')
	})

	it('leaves the error attribute off a success', () => {
		recordToolCall('read', true)
		expect(attributesOf('gen_ai.tool.call.count')[0]?.attributes).not.toHaveProperty(
			'namzu.tool.error',
		)
	})
})

describe('durations', () => {
	it('records a run in seconds, keyed by how it settled', () => {
		recordRunDuration('completed', 2500)
		const write = attributesOf('namzu.run.duration')[0]
		expect(write?.value).toBe(2.5)
		expect(write?.attributes['namzu.run.status']).toBe('completed')
	})

	it('records a model call in seconds', () => {
		recordModelDuration('m', 1500)
		expect(attributesOf('gen_ai.client.operation.duration')[0]?.value).toBe(1.5)
	})
})

describe('binding', () => {
	it('records through a provider installed AFTER the first write', () => {
		// The bug this replaces: an instrument bound before registration
		// captured the no-op meter and threw every write away forever.
		metrics.disable()
		resetRuntimeMetrics()
		recordToolCall('early', true)

		const late: Written[] = []
		metrics.setGlobalMeterProvider(fakeMeterProvider(late))
		recordToolCall('late', true)

		expect(late.map((w) => w.attributes['gen_ai.tool.name'])).toEqual(['late'])
	})

	it('reuses instruments while the meter is unchanged', () => {
		recordToolCall('a', true)
		recordToolCall('b', true)
		// Rebuilding per call would allocate on a hot path; both writes must
		// still land.
		expect(attributesOf('gen_ai.tool.call.count')).toHaveLength(2)
	})
})
