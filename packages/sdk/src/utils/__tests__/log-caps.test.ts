import { describe, expect, it } from 'vitest'
import { createLogger } from '../log/index.js'
import type { LogRecord, LogSink } from '../log/index.js'

function capturingSink(): { sink: LogSink; records: LogRecord[] } {
	const records: LogRecord[] = []
	return { sink: { emit: (record) => records.push(record) }, records }
}

function buildLogger(sink: LogSink) {
	return createLogger({
		sink,
		level: { current: 'debug' },
		resource: { 'service.name': 'test' },
		scope: 'test',
	})
}

function keyed(count: number, valueBytes = 1): Record<string, string> {
	const data: Record<string, string> = {}
	for (let i = 0; i < count; i++) {
		data[`k${String(i).padStart(2, '0')}`] = 'x'.repeat(valueBytes)
	}
	return data
}

describe('the attribute-count cap: at most 64', () => {
	it('drops the excess, in ascending key order, past 64 attributes', () => {
		const { sink, records } = capturingSink()
		const logger = buildLogger(sink)

		logger.info('too many attributes', keyed(70))

		expect(Object.keys(records[0]?.attributes ?? {})).toHaveLength(64)
		expect(logger.counters.attributesDropped).toBe(6)
		expect(records[0]?.attributes.k00).toBeUndefined()
		expect(records[0]?.attributes.k69).toBe('x')
	})

	it('is a no-op at exactly 64 attributes', () => {
		const { sink, records } = capturingSink()
		const logger = buildLogger(sink)

		logger.info('exactly the cap', keyed(64))

		expect(Object.keys(records[0]?.attributes ?? {})).toHaveLength(64)
		expect(logger.counters.attributesDropped).toBe(0)
	})
})

describe('the per-value byte cap: 8 KiB', () => {
	it('leaves a value at exactly 8 KiB untouched', () => {
		const { sink, records } = capturingSink()
		const logger = buildLogger(sink)

		const exact = 'a'.repeat(8 * 1024)
		logger.info('boundary', { 'namzu.test.value': exact })

		expect(records[0]?.attributes['namzu.test.value']).toBe(exact)
		expect(logger.counters.valuesTruncated).toBe(0)
	})

	it('truncates a value one byte over the cap and self-describes the cut', () => {
		const { sink, records } = capturingSink()
		const logger = buildLogger(sink)

		const over = 'a'.repeat(8 * 1024 + 1)
		logger.info('over the boundary', { 'namzu.test.value': over })

		expect(records[0]?.attributes['namzu.test.value']).toBe(
			`${'a'.repeat(8 * 1024)}…[truncated 1 bytes]`,
		)
		expect(logger.counters.valuesTruncated).toBe(1)
	})
})

describe('the total record byte cap: 16 KiB', () => {
	it('drops attributes in ascending key order until the record fits, and flags the record', () => {
		const { sink, records } = capturingSink()
		const logger = buildLogger(sink)

		logger.info('too big in total', keyed(40, 600))

		const record = records[0]
		expect(record).toBeDefined()
		const size = Buffer.byteLength(JSON.stringify(record), 'utf8')
		expect(size).toBeLessThanOrEqual(16 * 1024)
		expect(record?.attributes['namzu.log.truncated']).toBe(true)
		expect(record?.attributes.k00).toBeUndefined()
		expect(logger.counters.recordsTruncated).toBe(1)
	})

	it('does not touch a record that already fits', () => {
		const { sink, records } = capturingSink()
		const logger = buildLogger(sink)

		logger.info('small record', keyed(3, 10))

		expect(records[0]?.attributes['namzu.log.truncated']).toBeUndefined()
		expect(logger.counters.recordsTruncated).toBe(0)
	})
})
