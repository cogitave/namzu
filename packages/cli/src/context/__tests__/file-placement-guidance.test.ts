import { describe, expect, it } from 'vitest'

import { composeFilePlacementGuidance } from '../file-placement.js'
import { composeSessionSystemPrompt, sessionPromptInput } from '../system-prompt.js'

describe('the "Where files go" guidance', () => {
	it('renders only the current platform', () => {
		const linux = composeFilePlacementGuidance('linux')
		const mac = composeFilePlacementGuidance('darwin')
		const win = composeFilePlacementGuidance('win32')
		expect(linux).toContain('~/.local/share')
		expect(linux).not.toContain('~/Library')
		expect(linux).not.toContain('%APPDATA%')
		expect(mac).toContain('~/Library/Application Support')
		expect(mac).toContain('/Library/LaunchDaemons')
		expect(mac).not.toContain('~/.config')
		expect(win).toContain('%LOCALAPPDATA%')
		expect(win).not.toContain('~/Library')
		expect(composeFilePlacementGuidance('freebsd')).toBe(linux)
	})

	it.each(['linux', 'darwin', 'win32'] as const)('states the rules on %s', (platform) => {
		const text = composeFilePlacementGuidance(platform)
		for (const phrase of [
			'Temporary work',
			'named volumes',
			'projects folder',
			'home folder or the filesystem root without asking',
			'full path of every folder',
			'`rm -rf` only on a path this session created',
			'receipt',
			'Identity:',
			'Configuration:',
			'Data:',
			'Logs:',
			'Supervisor:',
			'Secrets:',
			'State:',
			'Monitoring:',
			'Host:',
			'name each item that deviates',
		]) {
			expect(text, phrase).toContain(phrase)
		}
	})

	it('is in the session prompt once and identical on every turn', () => {
		const facts = {
			anyToolDeferred: false,
			filePlacementGuidance: composeFilePlacementGuidance('linux'),
		}
		const turn = (permissionMode: string) =>
			composeSessionSystemPrompt(
				sessionPromptInput(facts, { workflowOffered: false, permissionMode }),
			) ?? ''
		const first = turn('auto')
		expect(first.split('# Where files go')).toHaveLength(2)
		expect(turn('auto')).toBe(first)
		expect(turn('default')).toBe(first)
	})
})
