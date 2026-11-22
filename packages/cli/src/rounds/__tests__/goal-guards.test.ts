import {
	type GoalRoundAuthority,
	InMemorySessionGoalStore,
	InMemorySessionStore,
	type SessionGoal,
	type SessionId,
	type TenantId,
	type TurnOutcome,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	DEFAULT_CLI_GOAL_MAX_ROUNDS,
	goalDefaults,
	goalStopSentence,
	recordGoalRound,
	roundAction,
	roundFailure,
	roundProgress,
	summarizeRound,
} from '../goal-guards.js'

const record = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({
	verdict: 'unchanged',
	basis: 'calls',
	changes: { total: 0, paths: [], outsideKnownTools: false },
	checks: [],
	...over,
})

describe('the limits a goal gets here', () => {
	it('are the backstop, the stall count and the check-in, with no budget, when nothing is set', () => {
		expect(goalDefaults(undefined)).toEqual({
			maxGoalRounds: DEFAULT_CLI_GOAL_MAX_ROUNDS,
			guards: { stallRounds: 3, checkInEvery: 50 },
		})
		expect(DEFAULT_CLI_GOAL_MAX_ROUNDS).toBe(1000)
	})

	it('take the settings, and 0 check-ins stays 0', () => {
		expect(
			goalDefaults({ maxRounds: 40, checkInEvery: 0, stallRounds: 2, tokenBudget: 9000 }),
		).toEqual({
			maxGoalRounds: 40,
			guards: { stallRounds: 2, checkInEvery: 0, tokenBudget: 9000 },
		})
	})
})

describe('what a finished turn did', () => {
	it('is progress when files changed, a command may have, or a check ran', () => {
		expect(
			roundProgress(record({ changes: { total: 1, paths: ['a.ts'], outsideKnownTools: false } })),
		).toBe('progress')
		expect(roundProgress(record({ verdict: 'unknown' }))).toBe('progress')
		expect(
			roundProgress(record({ checks: [{ command: 'pnpm test', step: 1, result: 'passed' }] })),
		).toBe('progress')
	})

	it('is empty when nothing changed and nothing ran, and unknown with no record', () => {
		expect(roundProgress(record())).toBe('empty')
		expect(roundProgress(undefined)).toBe('unknown')
	})

	it('names the failure by the commands whose latest run failed, and the last action', () => {
		const failing = record({
			verdict: 'failing',
			checks: [
				{ command: 'pnpm test', step: 2, result: 'failed', exitCode: 1 },
				{ command: 'pnpm lint', step: 3, result: 'passed' },
			],
		})
		expect(roundFailure(failing)).toBe('pnpm test (exit 1)')
		expect(roundAction(failing)).toBe('ran pnpm lint')
		expect(roundFailure(record())).toBeUndefined()
		expect(
			roundAction(record({ changes: { total: 3, paths: ['src/a.ts'], outsideKnownTools: false } })),
		).toBe('changed src/a.ts and 2 more')
		expect(roundAction(record())).toBeUndefined()
	})

	it('reads a completion claim as unknown, never as an empty turn', () => {
		const claimed = { phase: 'complete' } as SessionGoal
		expect(summarizeRound({ record: record(), goal: claimed, tokens: 5, costUsd: 0.1 })).toEqual({
			progress: 'unknown',
			tokens: 5,
			costUsd: 0.1,
		})
		const held = { phase: 'active', missing: ['x'] } as unknown as SessionGoal
		expect(
			summarizeRound({ record: record(), goal: held, tokens: undefined, costUsd: undefined })
				.progress,
		).toBe('unknown')
	})
})

describe('the sentence for a goal a rule stopped', () => {
	const base = { roundsAdmitted: 3, tokensUsed: 1500, costUsd: 0.05 }
	it('names the last action for no progress, and the failure for a repeat', () => {
		const stuck = {
			...base,
			phase: 'blocked',
			blockedReason: {
				code: 'no-progress',
				message:
					'3 automatic turns in a row changed nothing and checked nothing. Last action: ran pnpm test.',
			},
		} as unknown as SessionGoal
		expect(goalStopSentence(stuck)).toBe(
			'Goal stopped: 3 automatic turns in a row changed nothing and checked nothing. Last action: ran pnpm test. 3 automatic turns, 1,500 tokens, $0.05 so far. Run /goal resume to try again.',
		)
		const repeated = {
			...base,
			phase: 'blocked',
			blockedReason: { code: 'repeated-failure', message: 'The same failure ended 3 turns.' },
		} as unknown as SessionGoal
		expect(goalStopSentence(repeated)).toContain('Fix the cause, then run /goal resume.')
	})

	it('says nothing for a goal no rule stopped', () => {
		expect(goalStopSentence({ phase: 'active' } as SessionGoal)).toBeUndefined()
		expect(
			goalStopSentence({
				phase: 'blocked',
				blockedReason: { code: 'handed-back-to-a-person', message: 'x' },
			} as unknown as SessionGoal),
		).toBeUndefined()
	})
})

describe('writing a goal round down', () => {
	async function fixture() {
		const sessions = new InMemorySessionStore()
		const tenantId: TenantId = generateTenantId()
		const project = await sessions.createProject(
			{ tenantId, name: 'guards', rootPath: undefined },
			tenantId,
		)
		const session = await sessions.createSession(
			{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
			tenantId,
		)
		const goals = new InMemorySessionGoalStore({ sessions })
		const goal = await goals.createGoal(
			{ sessionId: session.id, objective: 'x', guards: { stallRounds: 3 } },
			tenantId,
		)
		return { goals, tenantId, sessionId: session.id as SessionId, goal }
	}

	it('stops the goal on the third empty turn, and says why only that once', async () => {
		const { goals, tenantId, sessionId, goal } = await fixture()
		let current: SessionGoal = goal
		const messages: (string | undefined)[] = []
		for (let i = 0; i < 3; i++) {
			const authority: GoalRoundAuthority = await goals.admitRound(sessionId, tenantId, current)
			messages.push(
				await recordGoalRound({
					goals,
					tenantId,
					round: authority,
					record: record(),
					tokens: 100,
					costUsd: 0.01,
				}),
			)
			current = (await goals.getGoal(sessionId, tenantId)) as SessionGoal
		}
		expect(messages.slice(0, 2)).toEqual([undefined, undefined])
		expect(messages[2]).toContain('Goal stopped: 3 automatic turns in a row changed nothing')
		expect(messages[2]).toContain('300 tokens')
		expect(current.phase).toBe('blocked')
		expect(current.blockedReason?.code).toBe('no-progress')
	})

	it('never throws, and does nothing for a store that cannot record', async () => {
		const { goals, tenantId, sessionId, goal } = await fixture()
		const round = { id: goal.id, sessionId }
		expect(
			await recordGoalRound({
				goals: { getGoal: goals.getGoal.bind(goals) },
				tenantId,
				round,
				record: record(),
				tokens: 1,
				costUsd: 0,
			}),
		).toBeUndefined()
		expect(
			await recordGoalRound({
				goals: {
					getGoal: async () => {
						throw new Error('disk gone')
					},
					recordRound: goals.recordRound?.bind(goals),
				},
				tenantId,
				round,
				record: record(),
				tokens: 1,
				costUsd: 0,
			}),
		).toBeUndefined()
	})
})
