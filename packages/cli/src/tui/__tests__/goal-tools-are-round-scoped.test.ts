/** Goal tools are a per-send capability, not a permanent model affordance. */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import {
	InMemorySessionGoalStore,
	InMemorySessionStore,
	MockLLMProvider,
	ProviderRegistry,
	SESSION_GOAL_TOOL_NAMES,
	type ToolRegistryContract,
	createUserMessage,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

let capturedBuildTools: (() => ToolRegistryContract) | null = null
vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async (options: { buildTools: () => ToolRegistryContract }) => {
		capturedBuildTools = options.buildTools
		throw new Error('subagent intentionally unavailable in this fixture')
	},
}))

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	capturedBuildTools = null
	for (const root of roots.splice(0)) removeTempDir(root)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

function detectedAnthropic(): DetectedProvider[] {
	return [
		{
			entry: {
				id: 'anthropic',
				label: 'Anthropic',
				defaultModel: 'claude-sonnet-4-5',
				requiresApiKey: true,
				envVars: ['ANTHROPIC_API_KEY'],
			},
			source: 'env',
			apiKey: 'sk-ant-not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
}

function offeredNames(request: MockLLMProvider['requests'][number]): string[] {
	return (request.tools ?? []).map((tool) => tool.function.name)
}

it('withholds goal tools from a human turn and exposes them only to an admitted run', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-goal-tool-scope-'))
	roots.push(cwd)
	const sessions = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const project = await sessions.createProject({ tenantId, name: 'goal scope' }, tenantId)
	const topicId = generateTopicId()
	const durableSession = await sessions.createSession(
		{ projectId: project.id, topicId, currentActor: null },
		tenantId,
	)
	const goals = new InMemorySessionGoalStore({ sessions })
	const created = await goals.createGoal(
		{ sessionId: durableSession.id, objective: 'finish the scoped work', maxGoalRounds: 4 },
		tenantId,
	)
	const provider = new MockLLMProvider({ turns: [{ text: 'human done' }, { text: 'goal done' }] })
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)

	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(prefs, detectedAnthropic(), {
		cwd,
		scope: {
			sessionId: durableSession.id,
			topicId,
			projectId: project.id,
			tenantId,
		},
		sessionGoals: goals,
	})
	try {
		const events: unknown[] = []
		for await (const _event of session.send([createUserMessage('ordinary human turn')], {
			runId: 'run_goal_human' as never,
		})) {
			events.push(_event)
		}
		const authority = await goals.admitRound(durableSession.id, tenantId, created)
		for await (const _event of session.send([createUserMessage('automatic goal turn')], {
			runId: 'run_goal_admitted' as never,
			goalRound: authority,
		})) {
			events.push(_event)
		}

		expect(provider.requests, JSON.stringify(events)).toHaveLength(2)
		for (const name of SESSION_GOAL_TOOL_NAMES) {
			expect(offeredNames(provider.requests[0]!)).not.toContain(name)
			expect(offeredNames(provider.requests[1]!)).toContain(name)
			expect(session.toolNames()).not.toContain(name)
			expect(session.promptExemptTools()).not.toContain(name)
		}

		expect(capturedBuildTools).not.toBeNull()
		const childNames = (capturedBuildTools as unknown as () => ToolRegistryContract)().listNames()
		for (const name of SESSION_GOAL_TOOL_NAMES) expect(childNames).not.toContain(name)
		expect(childNames).toContain('bash')
	} finally {
		await session.close()
	}
})
