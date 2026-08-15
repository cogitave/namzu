import { describe, expect, it } from 'vitest'
import { createLogger } from '../log/index.js'
import type { LogRecord, LogSink } from '../log/index.js'

function capturingSink(): { sink: LogSink; records: LogRecord[] } {
	const records: LogRecord[] = []
	return { sink: { emit: (record) => records.push(record) }, records }
}

describe('level is read per record, off the shared options object', () => {
	it('reflects a level flipped after construction, not the level at construction time', () => {
		const { sink, records } = capturingSink()
		const level: { current: 'debug' | 'info' | 'warn' | 'error' | 'silent' } = { current: 'warn' }

		const logger = createLogger({
			sink,
			level,
			resource: { 'service.name': 'test' },
			scope: 'test',
		})

		logger.info('below the warn threshold, filtered out')
		expect(records).toHaveLength(0)

		level.current = 'debug'
		logger.info('now above the (flipped) threshold')

		expect(records).toHaveLength(1)
		expect(records[0]?.body).toBe('now above the (flipped) threshold')
	})
})
