/**
 * A goal round in the real agent session, with a scripted model that hands the
 * task back to a person: the goal ends as not confirmed and is left blocked
 * with the reason, whatever it was confirmed by, and the `done` event carries
 * both the hand-back and the goal's ending. With the setting off the tool is
 * not there and the round goes on as it did.
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

async function round(options: { readonly handBack: boolean }) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-goal-handback-'))
	roots.push(cwd)
	const sessions = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const project = await sessions.createProject({ tenantId, name: 'goal hand back' }, tenantId)
	const topicId = generateTopicId()
	const durableSession = await sessions.createSession(
		{ projectId: project.id, topicId, currentActor: null },
		tenantId,
	)
	const goals = new InMemorySessionGoalStore({ sessions })
	const created = await goals.createGoal(
		{ sessionId: durableSession.id, objective: 'ship the release' },
		tenantId,
	)
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{
						id: 'h',
						name: 'hand_back_task',
						args: {
							kind: 'decision',
							blocker: 'two channels fit',
							tried: 'compared both',
							needed: 'pick one',
						},
					},
				],
			},
			{ text: 'Nothing else.' },
		],
	})
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(prefs, detectedAnthropic(), {
		cwd,
		scope: { sessionId: durableSession.id, topicId, projectId: project.id, tenantId },
		sessionGoals: goals,
		...(options.handBack ? { handBack: true } : {}),
	})
	try {
		const authority = await goals.admitRound(durableSession.id, tenantId, created)
		const events: AgentEvent[] = []
		for await (const event of session.send([createUserMessage('automatic goal turn')], {
			turnId: '2b7b0544-7f44-488d-95a2-2c1ed8f184f5' as never,
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

it('ends the goal as not confirmed and blocked, after one model call', async () => {
	const { done, goal, requests } = await round({ handBack: true })
	expect(requests).toBe(1)
	expect(goal?.phase).toBe('blocked')
	expect(done).toMatchObject({
		kind: 'done',
		handedBack: { kind: 'decision', blocker: 'two channels fit' },
		goalEnding: { ending: 'not-confirmed', handedBack: { kind: 'decision' } },
	})
})

it('does not hand anything back with the setting off', async () => {
	const { done, goal } = await round({ handBack: false })
	expect(goal?.phase).toBe('active')
	expect(done).not.toHaveProperty('handedBack')
	expect(done).not.toHaveProperty('goalEnding')
})
