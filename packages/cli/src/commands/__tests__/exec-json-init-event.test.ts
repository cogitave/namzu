import { describe, expect, it } from 'vitest'
import { initEvent } from '../exec-json.js'

describe('exec --json init event', () => {
	it('lists the folder, model, mode, tools, tool servers and commands', () => {
		const event = initEvent(
			{
				toolNames: () => ['read', 'bash'],
				mcpConnected: [{ name: 'docs' }],
				mcpFailed: [{ name: 'broken', reason: 'no' }],
				providerSummary: 'anthropic',
				modelSummary: 'm1',
			} as never,
			'default',
			'/work',
			'ses_1' as never,
		)
		expect(event).toMatchObject({
			kind: 'init',
			sessionId: 'ses_1',
			cwd: '/work',
			provider: 'anthropic',
			model: 'm1',
			permissionMode: 'default',
			tools: ['read', 'bash'],
			mcpServers: [
				{ name: 'docs', status: 'connected' },
				{ name: 'broken', status: 'failed' },
			],
		})
		expect(Array.isArray(event.slashCommands)).toBe(true)
	})

	it('leaves the session id out of a stateless run', () => {
		const event = initEvent(
			{
				toolNames: () => [],
				mcpConnected: [],
				mcpFailed: [],
				providerSummary: null,
				modelSummary: null,
			} as never,
			'default',
			'/w',
			null,
		)
		expect('sessionId' in event).toBe(false)
	})
})
