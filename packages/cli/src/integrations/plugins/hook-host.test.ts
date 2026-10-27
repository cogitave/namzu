import { describe, expect, it } from 'vitest'

import { hookPermissionMode } from './hook-host.js'

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
