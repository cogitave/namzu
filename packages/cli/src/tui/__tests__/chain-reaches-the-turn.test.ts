/**
 * The declared chain reaches `query()`, and it is REBUILT each turn.
 *
 * The kernel's own suite proves the swap; `provider-fallback-surface.test.ts`
 * proves the operator is told. Neither says anything about the hop in between —
 * a session that never passes `fallbackProviders` produces exactly the state
 * this PR exists to remove, with every other test still green
 * ("reachability is its own property").
 *
 * `query` is stubbed to capture its params, so this drives the real
 * `createAgentSession` — the real preferences, the real registry, the real
 * credential resolution — rather than re-deriving what it ought to build.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LLMProvider } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

const queryCalls: Array<{
	provider: LLMProvider
	fallbackProviders?: readonly { provider: LLMProvider; model?: string }[]
}> = []

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: (typeof queryCalls)[number]) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async () => ({
		gateway: {} as unknown,
		agentTool: {
			name: 'Agent',
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			execute: async () => ({ success: true, output: '' }),
		},
		allowedAgentIds: [],
	}),
}))

let workDir: string

beforeEach(() => {
	queryCalls.length = 0
	workDir = mkdtempSync(join(tmpdir(), 'namzu-chain-turn-'))
})

afterEach(() => {
	removeTempDir(workDir)
})

function detected(...ids: Array<'anthropic' | 'openai'>): DetectedProvider[] {
	return ids.map(
		(id) =>
			({
				entry: {
					id,
					label: id,
					defaultModel: id === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o',
					requiresApiKey: true,
					envVars: [id === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'],
				},
				source: 'env',
				apiKey: `not-a-real-${id}-key`,
				alternatives: [],
			}) as unknown as DetectedProvider,
	)
}

async function runOneTurn(prefs: Preferences, providers: DetectedProvider[]): Promise<void> {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(prefs, providers, { cwd: workDir })
	expect(session.hasProvider).toBe(true)
	for await (const _ of session.send([])) {
		// drain
	}
	await session.close()
}

describe('a declared chain reaches the turn', () => {
	it('passes every credentialed fallback, in the operator’s order, with its model', async () => {
		await runOneTurn(
			{
				version: 3,
				providers: [
					{ id: 'anthropic', model: 'claude-opus-4-7' },
					{ id: 'openai', model: 'gpt-4o' },
				],
			} as Preferences,
			detected('anthropic', 'openai'),
		)

		expect(queryCalls).toHaveLength(1)
		const chain = queryCalls[0]?.fallbackProviders ?? []
		expect(chain).toHaveLength(1)
		expect(chain[0]?.provider.id).toBe('openai')
		expect(chain[0]?.model).toBe('gpt-4o')
	})

	it('omits the option entirely for a single-provider setup', async () => {
		await runOneTurn(
			{ version: 3, providers: [{ id: 'anthropic' }] } as Preferences,
			detected('anthropic'),
		)

		expect(queryCalls).toHaveLength(1)
		expect(queryCalls[0]).not.toHaveProperty('fallbackProviders')
	})

	it('leaves out a fallback that has no credential rather than letting it 401 later', async () => {
		await runOneTurn(
			{ version: 3, providers: [{ id: 'anthropic' }, { id: 'openai' }] } as Preferences,
			detected('anthropic'),
		)

		expect(queryCalls).toHaveLength(1)
		expect(queryCalls[0]).not.toHaveProperty('fallbackProviders')
	})

	/**
	 * The turn, not the session, is the unit — and the drivers are rebuilt with
	 * it. A member list captured once at session creation would survive an OAuth
	 * rotation holding an expired token, which is a fallback that fails for
	 * exactly the reason it exists to survive.
	 */
	it('builds fresh member drivers on every turn', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(
			{
				version: 3,
				providers: [{ id: 'anthropic' }, { id: 'openai' }],
			} as Preferences,
			detected('anthropic', 'openai'),
			{ cwd: workDir },
		)

		for await (const _ of session.send([])) {
			// drain
		}
		for await (const _ of session.send([])) {
			// drain
		}
		await session.close()

		expect(queryCalls).toHaveLength(2)
		const first = queryCalls[0]?.fallbackProviders?.[0]?.provider
		const second = queryCalls[1]?.fallbackProviders?.[0]?.provider
		expect(first).toBeDefined()
		expect(second).toBeDefined()
		expect(second).not.toBe(first)
	})
})
