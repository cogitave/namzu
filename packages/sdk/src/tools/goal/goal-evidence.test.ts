import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { drainQuery } from '../../runtime/query/index.js'
import { InMemorySessionGoalStore } from '../../store/goal/index.js'
import { InMemorySessionLog } from '../../store/session-log/index.js'
import { InMemorySessionStore } from '../../store/session/memory.js'
import { toolset } from '../../toolsets/toolset.js'
import type { GoalRoundAuthority, SessionGoal } from '../../types/goal/index.js'
import { autoApproveHandler } from '../../types/hitl/index.js'
import type { SessionId, TenantId, TurnId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { MockTurn } from '../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import type { ToolContext } from '../../types/tool/index.js'
import { generateTenantId, generateTopicId } from '../../utils/id.js'
import {
	GoalConfirmation,
	type GoalJudge,
	type GoalJudgeInput,
	type GoalJudgement,
} from './confirmation.js'
import { buildSessionGoalTools } from './index.js'

const workdirs: string[] = []
afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

const evidence = [
	{ requirement: 'the tests pass', checked: 'ran pnpm test', result: 'exit 0' },
	{ requirement: 'the docs are updated', checked: 'read docs/a.md', result: 'section present' },
]
const complete = (list: unknown = evidence): MockTurn => ({
	toolCalls: [
		{
			id: 'u',
			name: 'update_goal',
			rawArguments: JSON.stringify({
				status: 'complete',
				...(list === undefined ? {} : { evidence: list }),
			}),
		},
	],
})

async function fixture() {
	const sessions = new InMemorySessionStore()
	const tenantId: TenantId = generateTenantId()
	const project = await sessions.createProject(
		{ tenantId, name: 'evidence', rootPath: undefined },
		tenantId,
	)
	const session = await sessions.createSession(
		{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
		tenantId,
	)
	const store = new InMemorySessionGoalStore({ sessions })
	const created = await store.createGoal({ sessionId: session.id, objective: 'ship it' }, tenantId)
	const authority = await store.admitRound(session.id, tenantId, created)
	return { store, session, tenantId, authority }
}

function toolContext(): ToolContext {
	return {
		sessionId: 's' as SessionId,
		turnId: 'turn' as TurnId,
		workingDirectory: process.cwd(),
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

async function claimComplete(
	setup: Awaited<ReturnType<typeof fixture>>,
	confirmation: GoalConfirmation | undefined,
	input: Record<string, unknown>,
) {
	const tools = buildSessionGoalTools(
		setup.store,
		() => setup.authority as GoalRoundAuthority,
		confirmation ? { confirmation } : {},
	)
	const update = tools.find((tool) => tool.name === 'update_goal')
	if (!update) throw new Error('no update_goal')
	return await update.execute({ status: 'complete', ...input }, toolContext())
}

describe('completion with evidence, without a judge', () => {
	it('needs evidence when the host asks for it', async () => {
		const setup = await fixture()
		const confirmation = new GoalConfirmation({
			store: setup.store,
			resolveAuthority: () => setup.authority,
			requireEvidence: true,
		})
		const result = await claimComplete(setup, confirmation, {})
		expect(result.success).toBe(false)
		expect(result.error).toContain('needs evidence')
		const partial = await claimComplete(setup, confirmation, {
			evidence: [{ requirement: 'a', checked: '', result: 'ok' }],
		})
		expect(partial.success).toBe(false)
		expect(partial.error).toContain('requirement, what was checked, and the result')
		expect((await setup.store.getGoal(setup.session.id, setup.tenantId))?.phase).toBe('active')
	})

	it('ends the goal on a bare report when the host does not ask for evidence', async () => {
		const setup = await fixture()
		const confirmation = new GoalConfirmation({
			store: setup.store,
			resolveAuthority: () => setup.authority,
		})
		expect((await claimComplete(setup, confirmation, {})).success).toBe(true)
		expect((await setup.store.getGoal(setup.session.id, setup.tenantId))?.phase).toBe('complete')
	})

	it('holds the first report once with the rubric and accepts the second that covers every requirement', async () => {
		const setup = await fixture()
		const confirmation = new GoalConfirmation({
			store: setup.store,
			resolveAuthority: () => setup.authority,
			requireEvidence: true,
		})
		const first = await claimComplete(setup, confirmation, { evidence })
		expect(first.success).toBe(false)
		expect(first.error).toContain('Held once for an audit')
		expect(first.error).toContain('Intent, earlier work')
		expect((await setup.store.getGoal(setup.session.id, setup.tenantId))?.phase).toBe('active')

		const missing = await claimComplete(setup, confirmation, { evidence: evidence.slice(0, 1) })
		expect(missing.success).toBe(false)
		expect(missing.error).toContain('the docs are updated')

		const second = await claimComplete(setup, confirmation, { evidence })
		expect(second.success).toBe(true)
		expect((await setup.store.getGoal(setup.session.id, setup.tenantId))?.phase).toBe('complete')
	})
})

interface Judged {
	readonly goal: SessionGoal
	readonly inputs: readonly GoalJudgeInput[]
	readonly notes: readonly string[]
	readonly requests: number
}

async function runWithJudge(options: {
	readonly script: readonly MockTurn[]
	readonly judge: GoalJudge | undefined
	readonly judgeActive?: () => boolean
	readonly maxRefusals?: number
}): Promise<Judged> {
	const setup = await fixture()
	const inputs: GoalJudgeInput[] = []
	const confirmation = new GoalConfirmation({
		store: setup.store,
		resolveAuthority: () => setup.authority,
		requireEvidence: true,
		...(options.judge
			? {
					judge: async (input) => {
						inputs.push(input)
						return await (options.judge as GoalJudge)(input)
					},
				}
			: {}),
		...(options.judgeActive ? { judgeActive: options.judgeActive } : {}),
		...(options.maxRefusals !== undefined ? { maxRefusals: options.maxRefusals } : {}),
	})
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-goal-evidence-'))
	workdirs.push(workingDirectory)
	const provider = new MockLLMProvider({ turns: [...options.script] })
	const turn = await drainQuery(
		{
			provider,
			toolsets: [
				toolset(
					'goal-test',
					buildSessionGoalTools(setup.store, () => setup.authority, { confirmation }),
				),
			],
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 1_000_000,
				maxIterations: 40,
				maxResponseTokens: 512,
				outcome: { beforeEnd: confirmation.beforeEnd('turn') },
			},
			agentId: 'agent_goal',
			agentName: 'Goal Agent',
			messages: [createUserMessage('ship it')],
			workingDirectory,
			sessionId: setup.session.id as SessionId,
			topicId: 'b8388597-184a-4544-916e-1e5fb3e6bc97' as TopicId,
			projectId: 'ddfe0aea-433a-4b7c-ba63-c7301ab2a1ff' as ProjectId,
			tenantId: setup.tenantId,
			sessionLog: new InMemorySessionLog({ sessionId: setup.session.id as SessionId }),
			resumeHandler: autoApproveHandler,
		},
		() => {},
	)
	expect(turn.status).toBe('completed')
	const goal = await setup.store.getGoal(setup.session.id, setup.tenantId)
	if (!goal) throw new Error('the goal went missing')
	const notes = provider.requests.flatMap((request) =>
		request.messages
			.map((m) => (typeof m.content === 'string' ? m.content : ''))
			.filter((text) => text.startsWith('The check of your completion report')),
	)
	return { goal, inputs, notes: [...new Set(notes)], requests: provider.requests.length }
}

describe('completion with a judge', () => {
	it('shows the judge the objective, evidence, record and final message, and ends the goal when it is met', async () => {
		const run = await runWithJudge({
			script: [complete(), { text: 'All done, tests pass.' }],
			judge: async () => ({ met: true, missing: [] }),
		})
		expect(run.goal.phase).toBe('complete')
		expect(run.inputs).toHaveLength(1)
		expect(run.inputs[0]).toMatchObject({
			objective: 'ship it',
			finalMessage: 'All done, tests pass.',
			outcome: 'nothing changed and no check ran',
		})
		expect(run.inputs[0]?.evidence).toEqual(evidence)
	})

	it('keeps the goal active and feeds back what is missing when the judge says it is not met', async () => {
		let asked = 0
		const run = await runWithJudge({
			script: [complete(), { text: 'Done.' }, complete(), { text: 'Done now.' }],
			judge: async (): Promise<GoalJudgement> => {
				asked += 1
				return asked === 1
					? { met: false, missing: ['the lint step was never run'] }
					: { met: true, missing: [] }
			},
		})
		expect(run.notes.join('\n')).toContain('the lint step was never run')
		expect(run.goal.phase).toBe('complete')
		expect(asked).toBe(2)
	})

	it('ends the turn with the goal active and the list kept for the next round once the refusals are used', async () => {
		const run = await runWithJudge({
			script: [complete(), { text: 'Done.' }, complete(), { text: 'Done again.' }],
			judge: async () => ({ met: false, missing: ['the docs page'] }),
			maxRefusals: 1,
		})
		expect(run.goal.phase).toBe('active')
		expect(run.goal.missing).toEqual(['the docs page'])
	})

	it('falls back to the self-audit when the judge cannot judge, and never blocks the goal', async () => {
		const run = await runWithJudge({
			script: [complete(), { text: 'Done.' }, complete(), { text: 'Done, audited.' }],
			judge: async () => undefined,
		})
		// First report held with the rubric, second accepted without a model call.
		expect(run.goal.phase).toBe('complete')
		expect(run.inputs).toHaveLength(2)
	})

	it('falls back when the judge throws', async () => {
		const run = await runWithJudge({
			script: [complete(), { text: 'Done.' }, complete(), { text: 'Done, audited.' }],
			judge: async () => {
				throw new Error('judge model unreachable')
			},
		})
		expect(run.goal.phase).toBe('complete')
	})

	it('does not use the judge while the host says it is off', async () => {
		const run = await runWithJudge({
			script: [complete(), complete(), { text: 'Done.' }],
			judge: async () => ({ met: false, missing: ['never asked'] }),
			judgeActive: () => false,
		})
		expect(run.inputs).toHaveLength(0)
		expect(run.goal.phase).toBe('complete')
	})
})
