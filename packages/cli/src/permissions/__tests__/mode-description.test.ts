import { describe, expect, it } from 'vitest'

import { permissionModeDescription } from '../mode.js'

describe('permissionModeDescription with a confining sandbox', () => {
	it('says shell commands inside the sandbox run without asking and leaving it always asks', () => {
		expect(permissionModeDescription('prompt', { sandboxedShell: true })).toBe(
			'Ask before changes. Shell commands inside the sandbox run without asking; leaving it always asks.',
		)
		expect(permissionModeDescription('accept-edits', { sandboxedShell: true })).toBe(
			'Allow file edits and simple file commands in your folders, and shell commands inside the sandbox; ask before anything else. Leaving the sandbox always asks.',
		)
	})

	it('is the usual sentence without it', () => {
		expect(permissionModeDescription('prompt')).toBe('Ask before changes and shell commands.')
		expect(permissionModeDescription('prompt', { sandboxedShell: false })).toBe(
			'Ask before changes and shell commands.',
		)
	})

	it('leaves the other modes alone', () => {
		for (const mode of ['plan', 'bypass', 'classify', 'strict', 'auto'] as const) {
			expect(permissionModeDescription(mode, { sandboxedShell: true })).toBe(
				permissionModeDescription(mode),
			)
		}
	})
})
