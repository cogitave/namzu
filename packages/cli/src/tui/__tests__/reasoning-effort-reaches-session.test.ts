/** Model-specific reasoning effort reaches the real AgentSession query boundary. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ProviderRegistry } from '@namzu/sdk'
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
	vi.restoreAllMocks()
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
	it('discovers an unseen model menu and default from its own provider catalogue', async () => {
		const provider = Object.assign(new MockLLMProvider(), {
			listModels: vi.fn(async () => [
				{
					id: 'fixture-model',
					name: 'New model',
					inputPrice: 0,
					outputPrice: 0,
					supportsToolUse: true,
					supportsStreaming: true,
					reasoningEffortLevels: ['medium', 'max'] as const,
					reasoningEffortDefault: 'max' as const,
				},
			]),
		})
		vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(
			{
				version: 3,
				providers: [{ id: 'openai', model: 'fixture-model' }],
				subagents: { active: [] },
			} as Preferences,
			detected('openai'),
			{ cwd },
		)
		try {
			expect(provider.listModels).toHaveBeenCalled()
			expect(session.reasoningEffortLevels).toEqual(['medium', 'max'])
			expect(session.reasoningEffortDefault).toBe('max')
		} finally {
			await session.close()
		}
	})
	it('opens without waiting for the model listing, sends to the chosen model, then publishes the menu', async () => {
		let release: (models: unknown[]) => void = () => undefined
		const listing = new Promise<unknown[]>((resolve) => {
			release = resolve
		})
		const provider = Object.assign(new MockLLMProvider(), {
			listModels: vi.fn(() => listing),
		})
		vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(
			{
				version: 3,
				providers: [{ id: 'openai', model: 'fixture-model' }],
				subagents: { active: [] },
			} as Preferences,
			detected('openai'),
			{ cwd, deferEffortCatalogue: true },
		)
		try {
			// The listing has been asked for and has not answered; the session is open.
			expect(session.hasProvider).toBe(true)
			expect(provider.listModels).toHaveBeenCalledOnce()
			expect(session.reasoningEffortLevels).toBeUndefined()
			expect(session.reasoningSettled).toBeDefined()
			for await (const _event of session.send([])) {
				// drain a turn while the listing is still pending
			}
			expect(queryCalls[0]?.turnConfig).toMatchObject({ model: 'fixture-model' })

			release([
				{
					id: 'fixture-model',
					name: 'New model',
					inputPrice: 0,
					outputPrice: 0,
					supportsToolUse: true,
					supportsStreaming: true,
					reasoningEffortLevels: ['medium', 'max'] as const,
					reasoningEffortDefault: 'max' as const,
				},
			])
			await session.reasoningSettled
			expect(session.reasoningEffortLevels).toEqual(['medium', 'max'])
			expect(session.reasoningEffortDefault).toBe('max')
		} finally {
			release([])
			await session.close()
		}
	})

	it('keeps a session usable when the model listing fails', async () => {
		const provider = Object.assign(new MockLLMProvider(), {
			listModels: vi.fn(async () => {
				throw new Error('503 service unavailable')
			}),
		})
		vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(
			{
				version: 3,
				providers: [{ id: 'openai', model: 'fixture-model' }],
				subagents: { active: [] },
			} as Preferences,
			detected('openai'),
			{ cwd, deferEffortCatalogue: true },
		)
		try {
			await expect(session.reasoningSettled).resolves.toEqual({})
			expect(session.hasProvider).toBe(true)
			expect(session.reasoningEffortLevels).toBeUndefined()
		} finally {
			await session.close()
		}
	})

	it('does not defer the listing unless the host asks', async () => {
		const provider = Object.assign(new MockLLMProvider(), { listModels: vi.fn(async () => []) })
		vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(
			{
				version: 3,
				providers: [{ id: 'openai', model: 'fixture-model' }],
				subagents: { active: [] },
			} as Preferences,
			detected('openai'),
			{ cwd },
		)
		try {
			expect(session.reasoningSettled).toBeUndefined()
		} finally {
			await session.close()
		}
	})

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

		expect(queryCalls[0]?.turnConfig).toMatchObject({ effort: 'high' })
		expect(queryCalls[1]?.turnConfig).not.toHaveProperty('effort')
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
