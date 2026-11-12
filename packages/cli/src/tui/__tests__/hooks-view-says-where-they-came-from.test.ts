import { describe, expect, it } from 'vitest'

import { renderHooks } from '../slashCommands.js'

describe('/hooks beside the config hooks', () => {
	it('names the file each hook came from', () => {
		expect(
			renderHooks({
				pre_tool_use: [
					{ command: 'guard.sh', source: '~/.namzu/config.yaml' },
					{ command: 'lint.sh', source: '/srv/app/namzu.config.json' },
				],
			}),
		).toBe(
			[
				'pre_tool_use',
				'  guard.sh · from ~/.namzu/config.yaml',
				'  lint.sh · from /srv/app/namzu.config.json',
			].join('\n'),
		)
	})

	it('lists the hooks plugins registered, with the plugin and the event', () => {
		const text = renderHooks(
			{ turn_end: [{ command: 'check.sh', source: 'a.json' }] },
			{
				pluginHooks: [
					{ plugin: 'review-bot', event: 'pre_tool_use' },
					{ plugin: 'review-bot', event: 'turn_end' },
				],
			},
		)
		expect(text).toContain('plugin hooks')
		expect(text).toContain('  pre_tool_use · plugin review-bot')
		expect(text).toContain('  turn_end · plugin review-bot')
	})

	it('lists plugin hooks even when the config has none', () => {
		const text = renderHooks(undefined, {
			pluginHooks: [{ plugin: 'review-bot', event: 'pre_tool_use' }],
		})
		expect(text).not.toContain('No hooks')
		expect(text).toContain('pre_tool_use · plugin review-bot')
	})

	it('says in one line when disableHooks is limiting the list', () => {
		const lines = renderHooks(
			{ pre_tool_use: [{ command: 'managed.sh', source: '/etc/namzu/config.json' }] },
			{ switch: 'disabled' },
		).split('\n')
		expect(lines[0]).toContain('turned off')
		expect(lines[0]).toContain('disableHooks')
		expect(lines[1]).toBe('pre_tool_use')
	})

	it('says so even when nothing is left, and for the managed-only statement', () => {
		expect(renderHooks(undefined, { switch: 'disabled' }).split('\n')[0]).toContain(
			'NAMZU_DISABLE_HOOKS',
		)
		expect(renderHooks(undefined, { switch: 'managed-only' }).split('\n')[0]).toContain(
			'hooksManagedOnly',
		)
	})
})
