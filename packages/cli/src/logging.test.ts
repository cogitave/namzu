import { afterEach, describe, expect, it } from 'vitest'

import { contextLogging, resolveLogFormat, resolveLogLevel } from './logging.js'

describe('resolveLogLevel', () => {
	it('--verbose wins outright: debug, regardless of env', () => {
		expect(resolveLogLevel({ verbose: true }, { NAMZU_LOG_LEVEL: 'error' })).toBe('debug')
	})

	it('--quiet wins outright: warn, regardless of env', () => {
		expect(resolveLogLevel({ quiet: true }, { NAMZU_LOG_LEVEL: 'debug' })).toBe('warn')
	})

	it('flag beats env: verbose=true with a conflicting NAMZU_LOG_LEVEL still returns debug', () => {
		expect(resolveLogLevel({ verbose: true }, { NAMZU_LOG_LEVEL: 'silent' })).toBe('debug')
	})

	it('no flag: a valid NAMZU_LOG_LEVEL is honoured', () => {
		expect(resolveLogLevel({}, { NAMZU_LOG_LEVEL: 'warn' })).toBe('warn')
	})

	it('no flag, silent env: silent is a real level filter and is honoured', () => {
		expect(resolveLogLevel({}, { NAMZU_LOG_LEVEL: 'silent' })).toBe('silent')
	})

	it('no flag, an env value that names no level: falls back to info rather than passing it through', () => {
		expect(resolveLogLevel({}, { NAMZU_LOG_LEVEL: 'trace' })).toBe('info')
	})

	it('nothing set anywhere: info — the floor that used to be silence', () => {
		expect(resolveLogLevel({}, {})).toBe('info')
	})
})

describe('resolveLogFormat', () => {
	it('the flag beats a conflicting NAMZU_LOG_FORMAT', () => {
		expect(resolveLogFormat({ logFormat: 'json' }, { NAMZU_LOG_FORMAT: 'pretty' })).toBe('json')
	})

	it('no flag: NAMZU_LOG_FORMAT=json is honoured', () => {
		expect(resolveLogFormat({}, { NAMZU_LOG_FORMAT: 'json' })).toBe('json')
	})

	it('no flag, an env value that names no format: falls back to pretty', () => {
		expect(resolveLogFormat({}, { NAMZU_LOG_FORMAT: 'yaml' })).toBe('pretty')
	})

	it('nothing set anywhere: pretty', () => {
		expect(resolveLogFormat({}, {})).toBe('pretty')
	})
})

describe('contextLogging', () => {
	afterEach(() => {
		delete process.env.NAMZU_LOG_LEVEL
	})

	it('returns ctx.logging unchanged when the context carries one', () => {
		const logging = { level: 'debug' as const, format: 'json' as const }
		expect(contextLogging({ logging })).toBe(logging)
	})

	it('falls back to the flagless/envless resolution when ctx.logging is absent', () => {
		process.env.NAMZU_LOG_LEVEL = 'warn'
		expect(contextLogging({})).toEqual({ level: 'warn', format: 'pretty' })
	})
})
