import { describe, expect, it } from 'vitest'
import { NOOP_LOGGER, NOOP_SINK, createLogger } from '../log/index.js'

describe('records that never reach a live sink', () => {
	it('NOOP_LOGGER counts every accepted call as dropped', () => {
		for (let i = 0; i < 5; i++) NOOP_LOGGER.info('discarded')
		expect(NOOP_LOGGER.counters.dropped).toBe(5)
	})

	it('any logger built directly on NOOP_SINK increments the same counter, by identity', () => {
		const logger = createLogger({
			sink: NOOP_SINK,
			level: { current: 'debug' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		})

		for (let i = 0; i < 4; i++) logger.warn('discarded')

		expect(logger.counters.dropped).toBe(4)
	})
})
