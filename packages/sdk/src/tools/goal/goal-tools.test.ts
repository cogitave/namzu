import { describe, expect, it } from 'vitest'

import { InMemorySessionGoalStore } from '../../store/goal/index.js'
import { InMemorySessionStore } from '../../store/session/memory.js'
import type { GoalRoundAuthority } from '../../types/goal/index.js'
import type { RunId, TenantId } from '../../types/ids/index.js'
import type { SessionStore } from '../../types/session/store.js'
import type { ToolContext, ToolDefinition } from '../../types/tool/index.js'
import { asRunId, generateTenantId, generateTopicId } from '../../utils/id.js'
import { SESSION_GOAL_TOOL_NAMES, buildSessionGoalTools } from './index.js'

async function fixture(maxGoalRounds = 8): Promise<{
	readonly store: InMemorySessionGoalStore
	readonly authority: GoalRoundAuthority
	readonly tenantId: TenantId
}> {
	const sessions: SessionStore = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const project = await sessions.createProject(
		{ tenantId, name: 'goal tools', rootPath: undefined },
		tenantId,
	)
	const session = await sessions.createSession(
		{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
		tenantId,
	)
	const store = new InMemorySessionGoalStore({ sessions })
	const created = await store.createGoal(
		{ sessionId: session.id, objective: 'finish the verified work', maxGoalRounds },
		tenantId,
	)
	return {
		store,
		tenantId,
		authority: await store.admitRound(session.id, tenantId, created),
	}
}

function context(runId: RunId): ToolContext {
	return {
		runId,
		workingDirectory: process.cwd(),
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

function named(tools: readonly ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find((candidate) => candidate.name === name)
	if (!tool) throw new Error(`missing tool ${name}`)
	return tool
}

describe('session goal tools', () => {
	it('publish the fixed capability names and read only through exact run authority', async () => {
		const { store, authority } = await fixture()
		const admittedRun = asRunId('run_goal_admitted')
		const tools = buildSessionGoalTools(store, (runId) =>
			runId === admittedRun ? authority : undefined,
		)
		expect(tools.map((tool) => tool.name)).toEqual(SESSION_GOAL_TOOL_NAMES)

		const read = await named(tools, 'get_goal').execute({}, context(admittedRun))
		expect(read).toMatchObject({
			success: true,
			data: { objective: 'finish the verified work', roundsAdmitted: 1 },
		})

		const refused = await named(tools, 'get_goal').execute({}, context(asRunId('run_human_turn')))
		expect(refused).toMatchObject({ success: false, output: '' })
		expect(refused.error).toContain('no admitted goal-round authority')
	})

	it('lets the admitted run complete only its exact current goal revision', async () => {
		const { store, authority } = await fixture()
		const runId = asRunId('run_goal_complete')
		const update = named(
			buildSessionGoalTools(store, () => authority),
			'update_goal',
		)

		const result = await update.execute({ status: 'complete' }, context(runId))
		expect(result).toMatchObject({
			success: true,
			data: { phase: 'complete', revision: authority.revision + 1 },
		})
		const replay = await update.execute({ status: 'complete' }, context(runId))
		expect(replay.success).toBe(false)
		expect(replay.error).toContain('Stale goal')
	})

	it('refuses model-reported blocking before the third admitted round', async () => {
		const { store, authority } = await fixture()
		const update = named(
			buildSessionGoalTools(store, () => authority),
			'update_goal',
		)
		const result = await update.execute(
			{ status: 'blocked', reasonCode: 'same-condition', reason: 'The same check failed.' },
			context(asRunId('run_goal_too_early')),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('before admitted round 3')
		expect(await store.getGoal(authority.sessionId, authority.tenantId)).toMatchObject({
			phase: 'active',
			revision: authority.revision,
		})
	})

	it('accepts a blocking reason on the third authority and stores it exactly', async () => {
		const { store, authority: first } = await fixture()
		const second = await store.admitRound(first.sessionId, first.tenantId, first)
		const third = await store.admitRound(second.sessionId, second.tenantId, second)
		const update = named(
			buildSessionGoalTools(store, () => third),
			'update_goal',
		)

		const result = await update.execute(
			{ status: 'blocked', reasonCode: 'same-condition', reason: 'The same check failed.' },
			context(asRunId('run_goal_third')),
		)
		expect(result).toMatchObject({
			success: true,
			data: {
				phase: 'blocked',
				blockedReason: { code: 'same-condition', message: 'The same check failed.' },
			},
		})
	})
})
