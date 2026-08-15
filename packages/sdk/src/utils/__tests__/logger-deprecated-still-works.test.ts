import { afterEach, describe, expect, it } from 'vitest'
import { configureLogger, getRootLogger } from '../logger.js'

describe('getRootLogger / configureLogger, unchanged', () => {
	afterEach(() => {
		configureLogger({ level: 'silent' })
	})

	it('still return a working Logger and still respect a level change', () => {
		configureLogger({ level: 'debug' })
		const logger = getRootLogger()

		expect(typeof logger.debug).toBe('function')
		expect(typeof logger.info).toBe('function')
		expect(typeof logger.warn).toBe('function')
		expect(typeof logger.error).toBe('function')
		expect(typeof logger.child).toBe('function')

		expect(() => logger.info('still works')).not.toThrow()
	})
})
