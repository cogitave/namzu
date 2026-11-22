import { describe, expect, it } from 'vitest'

import { SessionGoalActivation } from '../../../manager/goal/activation.js'
import { InMemorySessionGoalStore } from '../../../store/goal/index.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { generateTenantId, generateTopicId } from '../../../utils/id.js'
import { HostCommandRegistry } from '../index.js'
import { type GoalCommandDefaults, kernelHostCommands } from '../kernel-commands.js'

async function setup(defaults?: GoalCommandDefaults) {
	const sessions = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const project = await sessions.createProject({ tenantId, name: 'goal limits' }, tenantId)
	const session = await sessions.createSession(
		{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
		tenantId,
	)
	const store = new InMemorySessionGoalStore({ sessions })
	const registry = new HostCommandRegistry()
	registry.register(
		kernelHostCommands({
			goal: {
				store,
				sessionId: session.id,
				tenantId,
				activation: new SessionGoalActivation(),
				...(defaults ? { defaults } : {}),
			},
		}),
	)
	return { store, registry, sessionId: session.id, tenantId }
}

describe('/goal set --token-budget and --max-rounds', () => {
	it('keeps both on the goal, wherever the flags stand', async () => {
		const { store, registry, sessionId, tenantId } = await setup()
		const outcome = await registry.dispatch(
			'/goal set --token-budget 50000 make the tests pass --max-rounds=20',
		)
		expect(outcome).toMatchObject({ kind: 'ack' })
		const goal = await store.getGoal(sessionId, tenantId)
		expect(goal?.objective).toBe('make the tests pass')
		expect(goal?.guards?.tokenBudget).toBe(50_000)
		expect(goal?.maxGoalRounds).toBe(20)
	})

	it('gives a goal the host defaults, and lets the command override them', async () => {
		const defaults = { maxGoalRounds: 1000, guards: { stallRounds: 3, checkInEvery: 50 } }
		const plain = await setup(defaults)
		await plain.registry.dispatch('/goal fix it')
		const goal = await plain.store.getGoal(plain.sessionId, plain.tenantId)
		expect(goal?.maxGoalRounds).toBe(1000)
		expect(goal?.guards).toEqual({ stallRounds: 3, checkInEvery: 50 })

		const own = await setup(defaults)
		await own.registry.dispatch('/goal set --max-rounds 10 --token-budget 900 fix it')
		const chosen = await own.store.getGoal(own.sessionId, own.tenantId)
		expect(chosen?.maxGoalRounds).toBe(10)
		expect(chosen?.guards).toEqual({ stallRounds: 3, checkInEvery: 50, tokenBudget: 900 })
	})

	it('leaves the words of an objective alone when they only mention a flag', async () => {
		const { store, registry, sessionId, tenantId } = await setup()
		await registry.dispatch('/goal document the --max-rounds flag in the readme')
		const goal = await store.getGoal(sessionId, tenantId)
		expect(goal?.objective).toBe('document the --max-rounds flag in the readme')
		expect(goal?.guards).toBeUndefined()
	})

	it('refuses a number that is not a whole number of at least 1, and a flag on another command', async () => {
		const { registry } = await setup()
		for (const line of [
			'/goal set fix it --token-budget 0',
			'/goal set fix it --max-rounds many',
			'/goal set --token-budget 1.5 fix it',
		]) {
			expect(await registry.dispatch(line)).toMatchObject({ kind: 'refused' })
		}
		expect(await registry.dispatch('/goal pause --max-rounds 5')).toMatchObject({
			kind: 'refused',
		})
	})

	it('shows turns, tokens, cost, the budget and a check-in pause in the status', async () => {
		const { store, registry, sessionId, tenantId } = await setup({
			guards: { checkInEvery: 1, tokenBudget: 5000 },
		})
		await registry.dispatch('/goal fix it')
		let goal = await store.getGoal(sessionId, tenantId)
		if (!goal) throw new Error('no goal')
		await store.admitRound(sessionId, tenantId, goal)
		await store.recordRound?.(sessionId, tenantId, goal.id, {
			progress: 'progress',
			tokens: 1234,
			costUsd: 0.5,
		})
		goal = await store.getGoal(sessionId, tenantId)
		if (!goal) throw new Error('no goal')
		await store.admitRound(sessionId, tenantId, goal).catch(() => undefined)
		const shown = JSON.stringify(await registry.dispatch('/goal status'))
		expect(shown).toContain('Automatic turns: 1, up to 256')
		expect(shown).toContain('Tokens: 1,234')
		expect(shown).toContain('Cost: $0.50')
		expect(shown).toContain('Token budget: 5,000')
		expect(shown).toContain('Check-in: every 1 automatic turns')
		expect(shown).toContain(
			'Paused: Paused for a check-in after 1 automatic turn, 1,234 tokens, $0.50.',
		)
		expect(shown).not.toContain('/ 256')
	})

	it('resumes a check-in pause without resetting, and a round-limit stop with the raised cap', async () => {
		const { store, registry, sessionId, tenantId } = await setup({
			maxGoalRounds: 5,
			guards: { checkInEvery: 1 },
		})
		await registry.dispatch('/goal fix it')
		const goal = await store.getGoal(sessionId, tenantId)
		if (!goal) throw new Error('no goal')
		await store.admitRound(sessionId, tenantId, goal)
		const afterRound = await store.getGoal(sessionId, tenantId)
		if (!afterRound) throw new Error('no goal')
		await store.admitRound(sessionId, tenantId, afterRound).catch(() => undefined)
		expect((await store.getGoal(sessionId, tenantId))?.phase).toBe('paused')
		await registry.dispatch('/goal resume')
		const resumed = await store.getGoal(sessionId, tenantId)
		expect(resumed?.phase).toBe('active')
		expect(resumed?.roundsAdmitted).toBe(1)
	})
})
