import { describe, expect, it } from 'vitest'

import { PERMISSION_MODE_NAMES } from '../mode-names.js'
import { PERMISSION_MODES, permissionModeFromName, permissionModeName } from '../mode.js'

describe('the permission modes the root command lists', () => {
	it('are the modes a person can choose, in the same order, under the CLI’s words', () => {
		expect(PERMISSION_MODE_NAMES.map((name) => permissionModeFromName(name))).toEqual([
			...PERMISSION_MODES,
		])
	})

	it('give the CLI’s `auto` to the kernel’s classifier and keep the kernel’s own `auto` unnamed', () => {
		expect(permissionModeFromName('auto')).toBe('classify')
		expect(permissionModeFromName('bypass')).toBe('bypass')
		expect(permissionModeFromName('classify')).toBeUndefined()
		expect(permissionModeFromName('unattended')).toBeUndefined()
		expect(permissionModeName('classify')).toBe('auto')
		expect(permissionModeName('auto')).toBe('unattended')
		expect(permissionModeName('accept-edits')).toBe('accept-edits')
	})

	it('read only the words in the table, never an inherited property', () => {
		expect(permissionModeFromName('constructor')).toBeUndefined()
		expect(permissionModeFromName('__proto__')).toBeUndefined()
		expect(permissionModeFromName(undefined)).toBeUndefined()
	})
})
