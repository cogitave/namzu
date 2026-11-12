import { describe, expect, it } from 'vitest'

import { describeHooksStatus } from '../hooks.js'

describe('the hooks doctor row', () => {
	it('counts the attached hooks by the file they came from', () => {
		const result = describeHooksStatus({
			hooks: {
				pre_tool_use: [
					{ command: 'a', source: '~/.namzu/config.yaml' },
					{ command: 'b', source: '/srv/app/namzu.config.json' },
				],
				turn_end: [{ command: 'c', source: '~/.namzu/config.yaml' }],
			},
		})
		expect(result.status).toBe('pass')
		expect(result.message).toContain('3 shell hooks are attached')
		expect(result.message).toContain('2 from ~/.namzu/config.yaml')
		expect(result.message).toContain('1 from /srv/app/namzu.config.json')
		expect(result.message).toContain('No hook switch is on.')
	})

	it('says no hooks are attached, and which switch is on', () => {
		const result = describeHooksStatus({ disableHooks: true })
		expect(result.message).toContain('No shell hooks are attached.')
		expect(result.message).toContain('Switch on:')
		expect(result.message).toContain('disableHooks')
	})

	it('reports the managed-only statement over the person’s switch', () => {
		const result = describeHooksStatus({ disableHooks: true, hooksManagedOnly: true })
		expect(result.message).toContain('hooksManagedOnly')
	})

	it('does not count a project’s hooks while its folder is not trusted, and says so', () => {
		const config = {
			hooks: {
				pre_tool_use: [
					{ command: 'a', source: '~/.namzu/config.yaml' },
					{ command: 'b', source: '/srv/app/namzu.config.json' },
					{ command: 'c', source: '/srv/app/namzu.config.local.json' },
				],
			},
		}
		const result = describeHooksStatus(config, { cwd: '/srv/app', trusted: false })
		expect(result.message).toContain('1 shell hook is attached: 1 from ~/.namzu/config.yaml.')
		expect(result.message).toContain('2 more are declared in this folder')
		expect(result.message).toContain('not trusted')
		const trusted = describeHooksStatus(config, { cwd: '/srv/app', trusted: true })
		expect(trusted.message).toContain('3 shell hooks are attached')
	})
})
