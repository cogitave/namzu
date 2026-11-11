/**
 * Through the real session: a compaction mid-turn puts the session's own goal
 * in front of the model, scoped to that session and tenant, and the goal round
 * message it folded away is gone from the request.
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
	type SessionId,
	type TenantId,
	createSystemMessage,
	createUserMessage,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { GOAL_NOTE_HEADER } from '../../integrations/compaction/carried.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

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

const GOAL_ROUND_MESSAGE = 'Continue the goal: ship the reversible migration (round 2)'

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-goal-compaction-'))
	roots.push(cwd)
	const sessions = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const project = await sessions.createProject({ tenantId, name: 'goal compaction' }, tenantId)
	const make = async () => {
		const topicId = generateTopicId()
		const session = await sessions.createSession(
			{ projectId: project.id, topicId, currentActor: null },
			tenantId,
		)
		return { topicId, id: session.id }
	}
	const goals = new InMemorySessionGoalStore({ sessions })
	return { cwd, tenantId, projectId: project.id, make, goals }
}

async function firstRequest(
	f: Awaited<ReturnType<typeof fixture>>,
	scope: { id: SessionId; topicId: ReturnType<typeof generateTopicId> },
	goals: InMemorySessionGoalStore,
	earlier: string[] = [],
): Promise<string> {
	const provider = new MockLLMProvider({ turns: [{ text: 'ok' }] })
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(prefs, detectedAnthropic(), {
		cwd: f.cwd,
		scope: {
			sessionId: scope.id,
			topicId: scope.topicId,
			projectId: f.projectId,
			tenantId: f.tenantId,
		},
		sessionGoals: goals,
		compaction: { modelSummary: false, contextWindowTokens: 8_000 },
	})
	try {
		const history = [
			...earlier.map((content) => createSystemMessage(content)),
			createUserMessage(GOAL_ROUND_MESSAGE),
			...Array.from({ length: 30 }, (_, i) => createUserMessage(`turn ${i} `.repeat(200))),
			createUserMessage('what is left?'),
		]
		const events: unknown[] = []
		for await (const event of session.send(history)) events.push(event)
		expect(provider.requests, JSON.stringify(events)).not.toHaveLength(0)
		return JSON.stringify(provider.requests[0]?.messages)
	} finally {
		await session.close()
	}
}

it('carries the session own goal after a compaction, and no other session or tenant goal', async () => {
	const f = await fixture()
	const mine = await f.make()
	const other = await f.make()
	await f.goals.createGoal(
		{ sessionId: other.id, objective: 'the other session objective', maxGoalRounds: 4 },
		f.tenantId,
	)

	const without = await firstRequest(f, mine, f.goals)
	expect(without).toContain('COMPACTED CONTEXT')
	expect(without).not.toContain(GOAL_NOTE_HEADER)
	expect(without).not.toContain('the other session objective')

	await f.goals.createGoal(
		{ sessionId: mine.id, objective: 'ship the reversible migration', maxGoalRounds: 4 },
		f.tenantId,
	)
	const getGoal = vi.spyOn(f.goals, 'getGoal')
	const withGoal = await firstRequest(f, mine, f.goals)
	expect(withGoal).toContain('COMPACTED CONTEXT')
	// The goal round message itself is no longer a turn of the request (the summary may quote it).
	const messages = JSON.parse(withGoal) as { role: string; content: unknown }[]
	expect(
		messages.some(
			(m) => m.role === 'user' && JSON.stringify(m.content).includes(GOAL_ROUND_MESSAGE),
		),
	).toBe(false)
	expect(withGoal).toContain(GOAL_NOTE_HEADER)
	expect(withGoal).toContain('ship the reversible migration')
	expect(withGoal).not.toContain('the other session objective')
	expect(getGoal).toHaveBeenCalledWith(mine.id, f.tenantId)
	expect(getGoal.mock.calls.every(([sid, tid]) => sid === mine.id && tid === f.tenantId)).toBe(true)
})

it('does not read a goal that belongs to another tenant', async () => {
	const f = await fixture()
	const mine = await f.make()
	const foreign = generateTenantId() as TenantId
	expect(foreign).not.toBe(f.tenantId)
	const goals = new InMemorySessionGoalStore({ sessions: new InMemorySessionStore() })
	const getGoal = vi.spyOn(goals, 'getGoal')
	const request = await firstRequest(f, mine, goals)
	expect(request).not.toContain(GOAL_NOTE_HEADER)
	expect(getGoal.mock.calls.every(([, tid]) => tid === f.tenantId)).toBe(true)
})

it('a summary made outside the pass is kept as it was, and the new pass adds a freshly stamped note', async () => {
	const f = await fixture()
	const mine = await f.make()
	await f.goals.createGoal(
		{ sessionId: mine.id, objective: 'ship the reversible migration', maxGoalRounds: 4 },
		f.tenantId,
	)
	const first = JSON.parse(await firstRequest(f, mine, f.goals)) as {
		role: string
		content: string
	}[]
	const earlier = String(
		first.find((m) => m.role === 'system' && String(m.content).startsWith('[COMPACTED CONTEXT]'))
			?.content,
	)
	expect(earlier).toContain(GOAL_NOTE_HEADER)

	const second = JSON.parse(await firstRequest(f, mine, f.goals, [earlier])) as {
		role: string
		content: string
	}[]
	// A summary the pass did not make is opaque to it, so it stays; the note in it carries its own
	// "as of" stamp, and the pass adds a current one beside it.
	expect(second.filter((m) => m.role === 'system' && m.content === earlier)).not.toHaveLength(0)
	expect(second.filter((m) => String(m.content).includes(GOAL_NOTE_HEADER)).length).toBeGreaterThan(
		1,
	)
})
