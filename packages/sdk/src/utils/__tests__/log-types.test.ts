import { describe, expect, it } from 'vitest'
import { NOOP_SINK, createLogger } from '../log/index.js'
import type { Logger } from '../logger.js'

describe('the Logger interface', () => {
	it('is still satisfied by an object with exactly {debug,info,warn,error,child}', () => {
		const minimal: Logger = {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
			child: (): Logger => minimal,
		}

		expect(typeof minimal.debug).toBe('function')
		expect(Object.keys(minimal)).toEqual(['debug', 'info', 'warn', 'error', 'child'])
	})
})

describe('createLogger options', () => {
	it('has no field for a caller-supplied redaction pattern set', () => {
		createLogger({
			sink: NOOP_SINK,
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'test',
			// @ts-expect-error — LoggerOptions has no `patterns` field, deliberately.
			patterns: [['fake', /x/g]],
		})

		expect(true).toBe(true)
	})
})
