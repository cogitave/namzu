/** Model-specific reasoning effort reaches the real AgentSession query boundary. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type {
	DetectedProvider,
	Preferences,
	ProviderId,
} from '../../integrations/providers/index.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let cwd: string

beforeEach(() => {
	queryCalls.length = 0
	cwd = mkdtempSync(join(tmpdir(), 'namzu-effort-'))
})

afterEach(() => {
	removeTempDir(cwd)
})

function detected(...ids: ProviderId[]): DetectedProvider[] {
	return ids.map(
		(id) =>
			({
				entry: {
					id,
					label: id,
					defaultModel: 'fixture-model',
					requiresApiKey: true,
					envVars: [`${id.toUpperCase()}_API_KEY`],
				},
				source: 'env',
				apiKey: `not-a-real-${id}-key`,
				alternatives: [],
			}) as unknown as DetectedProvider,
	)
}

describe('the TUI reasoning-effort hop', () => {
	it('passes the selected level to query and omits the key at provider default', async () => {
		const { createAgentSession } = await import('../agent.js')
		const preferences = {
			version: 3,
			providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
			subagents: { active: [] },
		} as Preferences
		const session = await createAgentSession(preferences, detected('anthropic'), { cwd })
		try {
			for await (const _event of session.send([], { effort: 'high' })) {
				// drain the production AgentSession boundary
			}
			for await (const _event of session.send([])) {
				// drain the provider-default path
			}
		} finally {
			await session.close()
		}

		expect(queryCalls[0]?.runConfig).toMatchObject({ effort: 'high' })
		expect(queryCalls[1]?.runConfig).not.toHaveProperty('effort')
	})

	it('publishes the exact common menu for every usable fallback member', async () => {
		const { createAgentSession } = await import('../agent.js')
		const preferences = {
			version: 3,
			providers: [
				{ id: 'anthropic', model: 'claude-sonnet-5' },
				{ id: 'openai', model: 'gpt-5.2' },
			],
			subagents: { active: [] },
		} as Preferences
		const session = await createAgentSession(preferences, detected('anthropic', 'openai'), {
			cwd,
		})
		try {
			expect(session.reasoningEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh'])
			expect(Object.isFrozen(session.reasoningEffortLevels)).toBe(true)
		} finally {
			await session.close()
		}
	})

	it('distinguishes an unknown menu from a provider that explicitly offers none', async () => {
		const { createAgentSession } = await import('../agent.js')
		const unknown = await createAgentSession(
			{
				version: 3,
				providers: [{ id: 'openai', model: 'gateway/future-model' }],
				subagents: { active: [] },
			} as Preferences,
			detected('openai'),
			{ cwd },
		)
		const none = await createAgentSession(
			{
				version: 3,
				providers: [{ id: 'deepseek', model: 'deepseek-v4-flash' }],
				subagents: { active: [] },
			} as Preferences,
			detected('deepseek'),
			{ cwd },
		)
		try {
			expect(unknown.reasoningEffortLevels).toBeUndefined()
			expect(none.reasoningEffortLevels).toEqual([])
		} finally {
			await Promise.allSettled([unknown.close(), none.close()])
		}
	})
})
