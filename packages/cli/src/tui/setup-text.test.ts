import { describe, expect, it } from 'vitest'
import type { SetupProbe } from '../integrations/providers/setup.js'
import { setupInstallFailed, setupInstalling, setupRowStatus } from './setup-text.js'

const codex = {
	id: 'codex',
	label: 'Codex',
	binary: 'codex',
	npmPackage: '@openai/codex',
	provider: 'codex',
} as const
const WARNING = 'WARNING: proceeding, even though we could not create PATH aliases: EACCES'
const row = (over: Partial<SetupProbe>): SetupProbe => ({
	harness: codex,
	installed: true,
	version: '0.46.0',
	checked: true,
	raw: `${WARNING}\ncodex-cli 0.46.0`,
	access: '',
	...over,
})

describe('provider setup text', () => {
	it('says the version, not what the program printed', () => {
		expect(setupRowStatus(row({}), false)).toBe('Installed · version 0.46.0')
		expect(setupRowStatus(row({}), true)).not.toContain('WARNING')
	})
	it('says it could not check, and points at --debug', () => {
		const failed = row({ checked: false, version: '' })
		expect(setupRowStatus(failed, false)).toBe('Couldn’t check Codex. Details: --debug')
		expect(setupRowStatus(failed, false)).not.toContain('WARNING')
	})
	it('shows the program’s lines only with --debug', () => {
		expect(setupRowStatus(row({ checked: false, version: '' }), true)).toContain('WARNING')
	})
	it('says a missing program is not installed', () => {
		expect(setupRowStatus(row({ installed: false, checked: true, version: '' }), false)).toBe(
			'Not installed',
		)
	})
	it('keeps installer output off the screen', () => {
		expect(setupInstalling(codex)).toBe('Installing Codex… This can take a minute.')
		expect(setupInstallFailed(codex, 'npm ERR! code E403\nnpm ERR! 403', false)).toBe(
			'Couldn’t install Codex. Details: --debug',
		)
		expect(setupInstallFailed(codex, 'npm ERR! code E403', true)).toContain('npm ERR! code E403')
	})
})
