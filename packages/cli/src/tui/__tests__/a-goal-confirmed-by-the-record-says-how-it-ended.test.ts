/**
 * A goal round in the real agent session, with a scripted model: the setting
 * `goal.confirmedBy` decides whether the model's report ends the goal or the
 * record does, and the turn's `done` event says which of the endings it was.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import {
	InMemorySessionGoalStore,
	InMemorySessionStore,
	MockLLMProvider,
	ProviderRegistry,
	createUserMessage,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent } from '../agent.js'

vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async () => {
		throw new Error('subagent intentionally unavailable in this fixture')
	},
}))

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
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

async function roundWith(options: {
	readonly goalConfirmedBy?: 'model' | 'record'
	readonly confirmedBy?: 'model' | 'record'
}) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-goal-record-'))
	roots.push(cwd)
	const sessions = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const project = await sessions.createProject({ tenantId, name: 'goal record' }, tenantId)
	const topicId = generateTopicId()
	const durableSession = await sessions.createSession(
		{ projectId: project.id, topicId, currentActor: null },
		tenantId,
	)
	const goals = new InMemorySessionGoalStore({ sessions })
	const created = await goals.createGoal(
		{
			sessionId: durableSession.id,
			objective: 'nothing to do here',
			...(options.confirmedBy ? { confirmedBy: options.confirmedBy } : {}),
		},
		tenantId,
	)
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [{ id: 'u', name: 'update_goal', rawArguments: '{"status":"complete"}' }],
			},
			{ text: 'Nothing needed changing.' },
		],
	})
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(prefs, detectedAnthropic(), {
		cwd,
		scope: { sessionId: durableSession.id, topicId, projectId: project.id, tenantId },
		sessionGoals: goals,
		...(options.goalConfirmedBy ? { goalConfirmedBy: options.goalConfirmedBy } : {}),
	})
	try {
		const authority = await goals.admitRound(durableSession.id, tenantId, created)
		const events: AgentEvent[] = []
		for await (const event of session.send([createUserMessage('automatic goal turn')], {
			turnId: '1a7b0544-7f44-488d-95a2-2c1ed8f184f4' as never,
			goalRound: authority,
		})) {
			events.push(event)
		}
		const done = events.find((event) => event.kind === 'done')
		const goal = await goals.getGoal(durableSession.id, tenantId)
		return { done, goal, requests: provider.requests.length }
	} finally {
		await session.close()
	}
}

it('says the goal was stated and not checked when the record has nothing to confirm it with', async () => {
	const { done, goal, requests } = await roundWith({ goalConfirmedBy: 'record' })
	expect(requests).toBe(2)
	expect(goal?.phase).toBe('complete')
	expect(done).toMatchObject({
		kind: 'done',
		goalEnding: { ending: 'stated-not-checked', refusals: 0 },
	})
})

it('leaves the model’s report to end the goal, with no ending said, when nothing chose the record', async () => {
	const { done, goal } = await roundWith({})
	expect(goal?.phase).toBe('complete')
	expect(done).toBeDefined()
	expect(done).not.toHaveProperty('goalEnding')
})

it('lets a goal that chose the model keep it against a setting that says record', async () => {
	const { done, goal } = await roundWith({ goalConfirmedBy: 'record', confirmedBy: 'model' })
	expect(goal?.phase).toBe('complete')
	expect(done).not.toHaveProperty('goalEnding')
})

it('lets a goal that chose the record have it with the setting off', async () => {
	const { done } = await roundWith({ goalConfirmedBy: 'model', confirmedBy: 'record' })
	expect(done).toMatchObject({ goalEnding: { ending: 'stated-not-checked' } })
})
