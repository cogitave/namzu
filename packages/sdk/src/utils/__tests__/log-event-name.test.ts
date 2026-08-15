import { describe, expect, it } from 'vitest'
import { createLogger } from '../log/index.js'
import type { LogRecord, LogSink } from '../log/index.js'
import { EVENT_NAME_ATTRIBUTE } from '../log/types.js'

function capturingSink(): { sink: LogSink; records: LogRecord[] } {
	const records: LogRecord[] = []
	return { sink: { emit: (record) => records.push(record) }, records }
}

describe('LogRecord.eventName', () => {
	it('is promoted from the reserved namzu.event.name attribute, and the attribute is removed', () => {
		const { sink, records } = capturingSink()
		const logger = createLogger({
			sink,
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		})

		logger.info('ready', { [EVENT_NAME_ATTRIBUTE]: 'namzu.boot.ready', extra: 'kept' })

		expect(records).toHaveLength(1)
		expect(records[0]?.eventName).toBe('namzu.boot.ready')
		// Mutation: a `{ ...attrs, eventName: attrs[KEY] }` implementation that
		// COPIES instead of PROMOTES would leave the reserved key behind, and
		// this assertion is what catches it.
		expect(EVENT_NAME_ATTRIBUTE in (records[0]?.attributes ?? {})).toBe(false)
		expect(records[0]?.attributes.extra).toBe('kept')
	})

	it('leaves eventName undefined when no call site sets the reserved attribute', () => {
		const { sink, records } = capturingSink()
		const logger = createLogger({
			sink,
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		})

		logger.info('ordinary record')

		expect(records[0]?.eventName).toBeUndefined()
	})

	it('carries the promotion through a bound child logger', () => {
		const { sink, records } = capturingSink()
		const logger = createLogger({
			sink,
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		}).child({ component: 'boot' })

		logger.info('ready', { [EVENT_NAME_ATTRIBUTE]: 'namzu.boot.ready' })

		expect(records[0]?.eventName).toBe('namzu.boot.ready')
		expect(records[0]?.attributes.component).toBe('boot')
	})
})
