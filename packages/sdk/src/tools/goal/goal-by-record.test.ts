import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { drainQuery } from '../../runtime/query/index.js'
import { InMemorySessionGoalStore } from '../../store/goal/index.js'
import { InMemorySessionLog } from '../../store/session-log/index.js'
import { InMemorySessionStore } from '../../store/session/memory.js'
import { toolset } from '../../toolsets/toolset.js'
import type { GoalConfirmedBy, SessionGoal } from '../../types/goal/index.js'
import { autoApproveHandler } from '../../types/hitl/index.js'
import type { SessionId, TenantId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { MockTurn } from '../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { generateTenantId, generateTopicId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'
import { GoalConfirmation, type GoalEndingReport } from './confirmation.js'
import { buildSessionGoalTools } from './index.js'

/**
 * The continuation loop of a goal confirmed by the record, run through the
 * real query loop with a scripted model. Nothing here waits on a clock: every
 * step is a scripted model reply, and the loop's own count of them is the
 * measure.
 */

const workdirs: string[] = []
afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs.length = 0
})

const edit = { toolCalls: [{ id: 'e', name: 'edit', rawArguments: '{"path":"a.ts"}' }] }
const shell = (exit = 0, command = 'pnpm test'): MockTurn => ({
	toolCalls: [{ id: 'b', name: 'bash', rawArguments: JSON.stringify({ command, exit }) }],
})
const complete = (reasonCode?: string): MockTurn => ({
	toolCalls: [
		{
			id: 'u',
			name: 'update_goal',
			rawArguments: JSON.stringify({
				status: 'complete',
				...(reasonCode ? { reasonCode, reason: 'said plainly' } : {}),
			}),
		},
	],
})
const blocked: MockTurn = {
	toolCalls: [
		{
			id: 'u',
			name: 'update_goal',
			rawArguments: JSON.stringify({
				status: 'blocked',
				reasonCode: 'check-fails',
				reason: 'the test keeps failing',
			}),
		},
	],
}
const say = (text: string): MockTurn => ({ text })

interface Run {
	readonly requests: number
	readonly goal: SessionGoal
	readonly ending: GoalEndingReport | undefined
	readonly notes: readonly string[]
}

async function runGoal(options: {
	readonly script: readonly MockTurn[] | ((index: number) => MockTurn)
	readonly confirmedBy?: GoalConfirmedBy
	readonly defaultConfirmedBy?: GoalConfirmedBy
	readonly maxIterations?: number
	readonly maxRefusals?: number
	readonly round?: number
}): Promise<Run> {
	const sessions = new InMemorySessionStore()
	const tenantId: TenantId = generateTenantId()
	const project = await sessions.createProject(
		{ tenantId, name: 'goal by record', rootPath: undefined },
		tenantId,
	)
	const session = await sessions.createSession(
		{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
		tenantId,
	)
	const store = new InMemorySessionGoalStore({ sessions })
	const created = await store.createGoal(
		{
			sessionId: session.id,
			objective: 'make the tests pass',
			...(options.confirmedBy ? { confirmedBy: options.confirmedBy } : {}),
		},
		tenantId,
	)
	let authority = await store.admitRound(session.id, tenantId, created)
	for (let i = 1; i < (options.round ?? 1); i++) {
		authority = await store.admitRound(session.id, tenantId, authority)
	}
	const confirmation = new GoalConfirmation({
		store,
		resolveAuthority: () => authority,
		...(options.defaultConfirmedBy ? { defaultConfirmedBy: options.defaultConfirmedBy } : {}),
		...(options.maxRefusals !== undefined ? { maxRefusals: options.maxRefusals } : {}),
	})
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-goal-'))
	workdirs.push(workingDirectory)
	const provider = new MockLLMProvider(
		typeof options.script === 'function'
			? { nextTurn: (_params, index) => (options.script as (i: number) => MockTurn)(index) }
			: { turns: [...options.script] },
	)
	const turn = await drainQuery(
		{
			provider,
			toolsets: [
				toolset('goal-test', [
					defineTool({
						name: 'edit',
						description: 'edit a file',
						inputSchema: z.object({ path: z.string() }),
						category: 'custom',
						permissions: [],
						readOnly: false,
						destructive: false,
						concurrencySafe: false,
						execute: async (input) => ({
							success: true,
							output: 'edited',
							facts: { kind: 'edit', path: input.path, replacements: 1 },
						}),
					}),
					defineTool({
						name: 'bash',
						description: 'run a command',
						inputSchema: z.object({ command: z.string(), exit: z.number().optional() }),
						category: 'custom',
						permissions: [],
						readOnly: false,
						destructive: false,
						concurrencySafe: false,
						execute: async (input) => {
							const exitCode = input.exit ?? 0
							return {
								success: exitCode === 0,
								output: exitCode === 0 ? 'ok' : 'failed',
								...(exitCode === 0 ? {} : { error: `Command exited with code ${exitCode}` }),
								facts: { kind: 'command', command: input.command, exitCode },
							}
						},
					}),
					...buildSessionGoalTools(store, () => authority, { confirmation }),
				]),
			],
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 1_000_000,
				maxIterations: options.maxIterations ?? 60,
				maxResponseTokens: 512,
				outcome: { beforeEnd: confirmation.beforeEnd('turn') },
			},
			agentId: 'agent_goal',
			agentName: 'Goal Agent',
			messages: [createUserMessage('make the tests pass')],
			workingDirectory,
			sessionId: session.id as SessionId,
			topicId: 'b8388597-184a-4544-916e-1e5fb3e6bc97' as TopicId,
			projectId: 'ddfe0aea-433a-4b7c-ba63-c7301ab2a1ff' as ProjectId,
			tenantId,
			sessionLog: new InMemorySessionLog({ sessionId: session.id as SessionId }),
			resumeHandler: autoApproveHandler,
		},
		() => {},
	)
	expect(turn.status).toBe('completed')
	const goal = await store.getGoal(session.id, tenantId)
	if (!goal) throw new Error('the goal went missing')
	const notes = provider.requests.flatMap((request) =>
		request.messages
			.map((m) => (typeof m.content === 'string' ? m.content : ''))
			.filter((text) => text.startsWith('The record ')),
	)
	return {
		requests: provider.requests.length,
		goal,
		ending: confirmation.takeEnding('turn'),
		notes: [...new Set(notes)],
	}
}

describe('a goal confirmed by the record', () => {
	it('goes on after a pass is claimed over a failing check, and is confirmed once the check passes', async () => {
		const run = await runGoal({
			confirmedBy: 'record',
			script: [
				edit,
				shell(1),
				complete(),
				say('Done.'),
				edit,
				shell(0),
				complete(),
				say('Fixed and checked.'),
			],
		})
		expect(run.goal.phase).toBe('complete')
		expect(run.ending).toMatchObject({ ending: 'confirmed', refusals: 1 })
		expect(run.requests).toBe(8)
		expect(run.notes.some((note) => note.includes('`pnpm test` failed'))).toBe(true)
	})

	it('goes on after an edit past a passing check', async () => {
		const run = await runGoal({
			confirmedBy: 'record',
			script: [
				edit,
				shell(0),
				edit,
				complete(),
				say('Done.'),
				shell(0),
				complete(),
				say('Checked.'),
			],
		})
		expect(run.goal.phase).toBe('complete')
		expect(run.ending).toMatchObject({ ending: 'confirmed', refusals: 1 })
		expect(run.notes.join('\n')).toContain('files changed after the last passing check')
	})

	it('ends as stated, not checked, when the model says no check exists', async () => {
		const run = await runGoal({
			confirmedBy: 'record',
			script: [edit, complete('no-check-available'), say('There is no test here.')],
		})
		expect(run.goal.phase).toBe('complete')
		expect(run.ending).toMatchObject({ ending: 'stated-not-checked', refusals: 0 })
		expect(run.requests).toBe(3)
	})

	it('ends as stated, not checked, when nothing changed and nothing ran', async () => {
		const run = await runGoal({
			confirmedBy: 'record',
			script: [complete(), say('Nothing was needed.')],
		})
		expect(run.goal.phase).toBe('complete')
		expect(run.ending?.ending).toBe('stated-not-checked')
	})

	it('ends as not confirmed at the bound, with the record sentence kept on the goal', async () => {
		const run = await runGoal({
			confirmedBy: 'record',
			script: (index) =>
				index === 0 ? edit : ([shell(1), complete(), say('Done.')] as const)[(index - 1) % 3]!,
		})
		expect(run.goal.phase).toBe('blocked')
		expect(run.goal.blockedReason?.code).toBe('not-confirmed-by-record')
		expect(run.goal.blockedReason?.message).toContain('`pnpm test` failed')
		expect(run.ending).toMatchObject({ ending: 'not-confirmed', refusals: 3 })
		// one edit, then a check, a report and an answer for the first attempt and each of three refusals
		expect(run.requests).toBe(13)
	})

	it('ends as not confirmed, and is not pushed again, when the model says it could not', async () => {
		const run = await runGoal({
			confirmedBy: 'record',
			script: [edit, shell(1), complete(), say('Done.'), blocked, say('I could not make it pass.')],
		})
		expect(run.goal.phase).toBe('blocked')
		expect(run.goal.blockedReason?.message).toContain('The model said: the test keeps failing')
		expect(run.ending).toMatchObject({ ending: 'not-confirmed', refusals: 1 })
		expect(run.requests).toBe(6)
	})

	it('does not let a goal be blocked in the first round before the record has sent it back', async () => {
		const run = await runGoal({
			confirmedBy: 'record',
			script: [edit, shell(1), blocked, say('Cannot.')],
		})
		// the report was an error to the model, so nothing was held and nothing ended
		expect(run.goal.phase).toBe('active')
		expect(run.ending).toBeUndefined()
		expect(run.requests).toBe(4)
	})

	it('lets the existing limits win: a turn stopped by its iteration limit ends no goal', async () => {
		const run = await runGoal({
			confirmedBy: 'record',
			maxIterations: 4,
			script: (index) =>
				index === 0 ? edit : ([shell(1), complete(), say('Done.')] as const)[(index - 1) % 3]!,
		})
		expect(run.goal.phase).toBe('active')
		expect(run.ending).toBeUndefined()
	})

	it('follows the host setting when the goal does not choose, and the goal wins when it does', async () => {
		const byDefault = await runGoal({
			defaultConfirmedBy: 'record',
			script: [edit, shell(1), complete(), say('Done.'), edit, shell(0), complete(), say('Fixed.')],
		})
		expect(byDefault.ending?.ending).toBe('confirmed')
		const chosen = await runGoal({
			defaultConfirmedBy: 'record',
			confirmedBy: 'model',
			script: [edit, shell(1), complete(), say('Done.')],
		})
		expect(chosen.ending).toBeUndefined()
		expect(chosen.goal.phase).toBe('complete')
	})
})

describe('the setting off', () => {
	it('completes on the first report, as it always did, and adds nothing to the turn', async () => {
		const run = await runGoal({
			script: [edit, shell(1), complete(), say('Done.')],
		})
		expect(run.goal.phase).toBe('complete')
		expect(run.ending).toBeUndefined()
		expect(run.requests).toBe(4)
		expect(run.notes).toEqual([])
	})
})
