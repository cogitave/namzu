import { describe, expect, it } from 'vitest'

import { hookPermissionMode, hookSessionMode } from './hook-host.js'

describe('hookPermissionMode', () => {
	it.each([
		['prompt', 'default'],
		['strict', 'default'],
		['accept-edits', 'acceptEdits'],
		['plan', 'plan'],
		['bypass', 'bypassPermissions'],
		['classify', 'auto'],
	] as const)('says %s as %s', (mode, word) => {
		expect(hookPermissionMode(mode)).toBe(word)
	})
})

describe('hookSessionMode', () => {
	it('says default before any mode is known, because the session asks', () => {
		expect(hookSessionMode(undefined, undefined)).toBe('default')
	})
	it('prefers the live mode, then the configured one', () => {
		expect(hookSessionMode('plan', 'bypass')).toBe('plan')
		expect(hookSessionMode(undefined, 'accept-edits')).toBe('acceptEdits')
	})
})
