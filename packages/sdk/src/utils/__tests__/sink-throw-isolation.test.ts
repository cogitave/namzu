import { describe, expect, it } from 'vitest'
import { createLogger } from '../log/index.js'
import type { LogSink } from '../log/index.js'

describe('a sink whose emit() throws', () => {
	it('never propagates into the caller, and is counted as dropped exactly once per call', () => {
		const throwingSink: LogSink = {
			emit() {
				throw new Error('host sink is broken')
			},
		}

		const logger = createLogger({
			sink: throwingSink,
			level: { current: 'debug' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		})

		expect(() => logger.info('one')).not.toThrow()
		expect(() => logger.warn('two')).not.toThrow()
		expect(() => logger.error('three')).not.toThrow()

		expect(logger.counters.dropped).toBe(3)
	})
})
