import { describe, expect, it } from 'vitest'

import type { SessionGoal } from '../../../types/goal/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { generateTenantId, generateTopicId } from '../../../utils/id.js'
import { InMemorySessionStore } from '../../session/memory.js'
import {
	DEFAULT_MAX_GOAL_ROUNDS,
	GoalBudgetLimitError,
	GoalCheckInError,
	GoalRoundLimitError,
	InMemorySessionGoalStore,
	goalUsageSentence,
} from '../index.js'

async function fixture(): Promise<{
	readonly store: InMemorySessionGoalStore
	readonly sessionId: SessionId
	readonly tenantId: TenantId
}> {
	const sessions = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const project = await sessions.createProject(
		{ tenantId, name: 'goal guards', rootPath: undefined },
		tenantId,
	)
	const session = await sessions.createSession(
		{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
		tenantId,
	)
	return { store: new InMemorySessionGoalStore({ sessions }), sessionId: session.id, tenantId }
}

const empty = { progress: 'empty' as const }
const worked = { progress: 'progress' as const, action: 'edited a.ts' }

async function admit(
	store: InMemorySessionGoalStore,
	sessionId: SessionId,
	tenantId: TenantId,
	goal: SessionGoal,
) {
	return await store.admitRound(sessionId, tenantId, goal)
}

describe('the stop rules of a goal', () => {
	it('keeps the kernel cap and applies no rule to a goal that chose none', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal({ sessionId, objective: 'x' }, tenantId)
		expect(goal.maxGoalRounds).toBe(DEFAULT_MAX_GOAL_ROUNDS)
		expect(goal.guards).toBeUndefined()
		for (let i = 0; i < 5; i++) {
			const authority = await admit(store, sessionId, tenantId, goal)
			goal = (await store.recordRound?.(sessionId, tenantId, goal.id, empty)) as SessionGoal
			expect(goal.phase).toBe('active')
			expect(authority.round).toBe(i + 1)
		}
	})

	it('blocks as no-progress after the third empty turn in a row, naming the last action', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal(
			{ sessionId, objective: 'x', guards: { stallRounds: 3 } },
			tenantId,
		)
		await admit(store, sessionId, tenantId, goal)
		goal = (await store.recordRound?.(sessionId, tenantId, goal.id, worked)) as SessionGoal
		for (let i = 0; i < 2; i++) {
			await admit(store, sessionId, tenantId, goal)
			goal = (await store.recordRound?.(sessionId, tenantId, goal.id, empty)) as SessionGoal
			expect(goal.phase).toBe('active')
		}
		await admit(store, sessionId, tenantId, goal)
		goal = (await store.recordRound?.(sessionId, tenantId, goal.id, empty)) as SessionGoal
		expect(goal.phase).toBe('blocked')
		expect(goal.blockedReason?.code).toBe('no-progress')
		expect(goal.blockedReason?.message).toContain('Last action: edited a.ts')
	})

	it('counts an empty turn only when the turns are in a row', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal(
			{ sessionId, objective: 'x', guards: { stallRounds: 3 } },
			tenantId,
		)
		for (const outcome of [empty, empty, worked, empty, empty]) {
			await admit(store, sessionId, tenantId, goal)
			goal = (await store.recordRound?.(sessionId, tenantId, goal.id, outcome)) as SessionGoal
		}
		expect(goal.phase).toBe('active')
		expect(goal.quietRounds).toBe(2)
	})

	it('blocks as repeated-failure when the same failure ends three turns in a row', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal(
			{ sessionId, objective: 'x', guards: { stallRounds: 3 } },
			tenantId,
		)
		const failing = { progress: 'progress' as const, failureSignature: 'pnpm test exited 1' }
		for (const outcome of [
			failing,
			{ ...failing, failureSignature: 'tsc exited 2' },
			failing,
			failing,
		]) {
			await admit(store, sessionId, tenantId, goal)
			goal = (await store.recordRound?.(sessionId, tenantId, goal.id, outcome)) as SessionGoal
			expect(goal.phase).toBe('active')
		}
		await admit(store, sessionId, tenantId, goal)
		goal = (await store.recordRound?.(sessionId, tenantId, goal.id, failing)) as SessionGoal
		expect(goal.phase).toBe('blocked')
		expect(goal.blockedReason?.code).toBe('repeated-failure')
		expect(goal.blockedReason?.message).toContain('pnpm test exited 1')
	})

	it('resumes a stalled goal with its stall counts started again', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal(
			{ sessionId, objective: 'x', guards: { stallRounds: 2 } },
			tenantId,
		)
		for (let i = 0; i < 2; i++) {
			await admit(store, sessionId, tenantId, goal)
			goal = (await store.recordRound?.(sessionId, tenantId, goal.id, empty)) as SessionGoal
		}
		expect(goal.phase).toBe('blocked')
		const resumed = await store.resumeGoal(sessionId, tenantId, goal)
		expect(resumed.phase).toBe('active')
		expect(resumed.quietRounds).toBeUndefined()
		expect(resumed.roundsAdmitted).toBe(2)
	})

	it('pauses for a check-in every N admitted rounds and resumes without resetting the count', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal(
			{ sessionId, objective: 'x', guards: { checkInEvery: 3 } },
			tenantId,
		)
		for (let i = 0; i < 3; i++) {
			await admit(store, sessionId, tenantId, goal)
			goal = (await store.recordRound?.(sessionId, tenantId, goal.id, {
				...worked,
				tokens: 100,
				costUsd: 0.25,
			})) as SessionGoal
		}
		const refused = await admit(store, sessionId, tenantId, goal).catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(GoalCheckInError)
		const paused = (await store.getGoal(sessionId, tenantId)) as SessionGoal
		expect(paused.phase).toBe('paused')
		expect(paused.pauseReason?.code).toBe('check-in')
		expect(paused.pauseReason?.message).toContain('3 automatic turns, 300 tokens, $0.75')

		const resumed = await store.resumeGoal(sessionId, tenantId, paused)
		expect(resumed.roundsAdmitted).toBe(3)
		expect(resumed.pauseReason).toBeUndefined()
		// The next batch of three runs before the next check-in.
		let goalNow = resumed
		for (let i = 0; i < 3; i++) {
			const authority = await admit(store, sessionId, tenantId, goalNow)
			expect(authority.round).toBe(4 + i)
			goalNow = (await store.recordRound?.(sessionId, tenantId, goalNow.id, worked)) as SessionGoal
		}
		await expect(admit(store, sessionId, tenantId, goalNow)).rejects.toBeInstanceOf(
			GoalCheckInError,
		)
	})

	it('treats checkInEvery 0 as off', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal(
			{ sessionId, objective: 'x', guards: { checkInEvery: 0 } },
			tenantId,
		)
		for (let i = 0; i < 4; i++) {
			await admit(store, sessionId, tenantId, goal)
			goal = (await store.recordRound?.(sessionId, tenantId, goal.id, worked)) as SessionGoal
		}
		expect(goal.phase).toBe('active')
	})

	it('gives one wrap-up round at the token budget, then blocks as budget-limited', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal(
			{ sessionId, objective: 'x', guards: { tokenBudget: 1000 } },
			tenantId,
		)
		await admit(store, sessionId, tenantId, goal)
		goal = (await store.recordRound?.(sessionId, tenantId, goal.id, {
			...worked,
			tokens: 1200,
		})) as SessionGoal
		const wrapUp = await admit(store, sessionId, tenantId, goal)
		expect(wrapUp.wrapUp).toBe(true)
		goal = (await store.recordRound?.(sessionId, tenantId, goal.id, {
			...worked,
			tokens: 50,
		})) as SessionGoal
		const refused = await admit(store, sessionId, tenantId, goal).catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(GoalBudgetLimitError)
		const blocked = (await store.getGoal(sessionId, tenantId)) as SessionGoal
		expect(blocked.blockedReason?.code).toBe('budget-limited')
		expect(blocked.blockedReason?.message).toContain('1,000-token budget')
	})

	it('goes on after a budget stop only when the budget is raised on resume', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal(
			{ sessionId, objective: 'x', guards: { tokenBudget: 100 } },
			tenantId,
		)
		await admit(store, sessionId, tenantId, goal)
		goal = (await store.recordRound?.(sessionId, tenantId, goal.id, {
			...worked,
			tokens: 150,
		})) as SessionGoal
		await admit(store, sessionId, tenantId, goal)
		goal = (await store.recordRound?.(sessionId, tenantId, goal.id, worked)) as SessionGoal
		await admit(store, sessionId, tenantId, goal).catch(() => undefined)
		const blocked = (await store.getGoal(sessionId, tenantId)) as SessionGoal
		const resumed = await store.resumeGoal(sessionId, tenantId, blocked, { tokenBudget: 10_000 })
		expect(resumed.guards?.tokenBudget).toBe(10_000)
		expect((await admit(store, sessionId, tenantId, resumed)).wrapUp).toBeUndefined()
	})

	it('blocks at the backstop and lets a resume raise it', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal({ sessionId, objective: 'x', maxGoalRounds: 2 }, tenantId)
		for (let i = 0; i < 2; i++) {
			await admit(store, sessionId, tenantId, goal)
			goal = (await store.recordRound?.(sessionId, tenantId, goal.id, worked)) as SessionGoal
		}
		await expect(admit(store, sessionId, tenantId, goal)).rejects.toBeInstanceOf(
			GoalRoundLimitError,
		)
		const blocked = (await store.getGoal(sessionId, tenantId)) as SessionGoal
		expect(blocked.blockedReason?.code).toBe('round-limit')
		const resumed = await store.resumeGoal(sessionId, tenantId, blocked, { maxGoalRounds: 5 })
		expect(resumed.maxGoalRounds).toBe(5)
		expect((await admit(store, sessionId, tenantId, resumed)).round).toBe(3)
	})

	it('adds tokens and cost, keeps what the judge found missing, and hands it to the next round once', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal({ sessionId, objective: 'x' }, tenantId)
		await admit(store, sessionId, tenantId, goal)
		goal = (await store.recordRound?.(sessionId, tenantId, goal.id, {
			progress: 'unknown',
			tokens: 10,
			costUsd: 0.5,
			missing: ['the lint step'],
		})) as SessionGoal
		expect(goal.missing).toEqual(['the lint step'])
		expect(goalUsageSentence(goal)).toBe('1 automatic turn, 10 tokens, $0.50')
		const next = await admit(store, sessionId, tenantId, goal)
		expect(next.missing).toEqual(['the lint step'])
		const after = (await store.getGoal(sessionId, tenantId)) as SessionGoal
		expect(after.missing).toBeUndefined()
	})

	it('fills in the stop rules a saved goal lacks on resume, counting a new check-in from there', async () => {
		const { store, sessionId, tenantId } = await fixture()
		let goal = await store.createGoal({ sessionId, objective: 'x' }, tenantId)
		for (let i = 0; i < 4; i++) {
			await admit(store, sessionId, tenantId, goal)
			goal = (await store.recordRound?.(sessionId, tenantId, goal.id, worked)) as SessionGoal
		}
		const paused = await store.pauseGoal(sessionId, tenantId, goal)
		const resumed = await store.resumeGoal(sessionId, tenantId, paused, {
			guards: { stallRounds: 3, checkInEvery: 2 },
		})
		expect(resumed.guards).toEqual({ stallRounds: 3, checkInEvery: 2 })
		expect((await admit(store, sessionId, tenantId, resumed)).round).toBe(5)
	})

	it('keeps the rules a goal already has when a resume offers others', async () => {
		const { store, sessionId, tenantId } = await fixture()
		const goal = await store.createGoal(
			{ sessionId, objective: 'x', guards: { checkInEvery: 0, stallRounds: 9 } },
			tenantId,
		)
		const paused = await store.pauseGoal(sessionId, tenantId, goal)
		const resumed = await store.resumeGoal(sessionId, tenantId, paused, {
			guards: { stallRounds: 3, checkInEvery: 50, tokenBudget: 100 },
		})
		expect(resumed.guards).toEqual({ stallRounds: 9, checkInEvery: 0, tokenBudget: 100 })
	})

	it('refuses guards that are not whole numbers', async () => {
		const { store, sessionId, tenantId } = await fixture()
		await expect(
			store.createGoal({ sessionId, objective: 'x', guards: { stallRounds: 0 } }, tenantId),
		).rejects.toThrow(/stallRounds/)
		await expect(
			store.createGoal({ sessionId, objective: 'x', guards: { tokenBudget: 1.5 } }, tenantId),
		).rejects.toThrow(/tokenBudget/)
		await expect(
			store.createGoal({ sessionId, objective: 'x', guards: { checkInEvery: -1 } }, tenantId),
		).rejects.toThrow(/checkInEvery/)
	})

	it('reads a goal stored before the new fields existed', async () => {
		const { store, sessionId, tenantId } = await fixture()
		const goal = await store.createGoal({ sessionId, objective: 'x' }, tenantId)
		const authority = await admit(store, sessionId, tenantId, goal)
		const read = (await store.getGoal(sessionId, tenantId)) as SessionGoal
		expect(read.tokensUsed).toBeUndefined()
		expect(authority.wrapUp).toBeUndefined()
		const recorded = (await store.recordRound?.(sessionId, tenantId, goal.id, empty)) as SessionGoal
		expect(recorded.phase).toBe('active')
		expect(recorded.tokensUsed).toBe(0)
	})
})
