import { describe, expect, it } from 'vitest'

import { InMemorySessionGoalStore } from '../../store/goal/index.js'
import { InMemorySessionStore } from '../../store/session/memory.js'
import type { GoalConfirmedBy } from '../../types/goal/index.js'
import type { HandBack } from '../../types/session/hand-back.js'
import { generateTenantId, generateTopicId } from '../../utils/id.js'
import { GoalConfirmation, describeGoalEnding } from './confirmation.js'

const handBack: HandBack = {
	kind: 'decision',
	blocker: 'two designs fit and only the owner can pick',
	tried: 'compared both',
	needed: 'pick one',
}

async function setup(confirmedBy?: GoalConfirmedBy) {
	const sessions = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const project = await sessions.createProject(
		{ tenantId, name: 'hb', rootPath: undefined },
		tenantId,
	)
	const session = await sessions.createSession(
		{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
		tenantId,
	)
	const store = new InMemorySessionGoalStore({ sessions })
	const created = await store.createGoal(
		{ sessionId: session.id, objective: 'ship it', ...(confirmedBy ? { confirmedBy } : {}) },
		tenantId,
	)
	const authority = await store.admitRound(session.id, tenantId, created)
	let current: typeof authority | undefined = authority
	const confirmation = new GoalConfirmation({ store, resolveAuthority: () => current })
	return {
		store,
		session,
		tenantId,
		confirmation,
		drop: () => {
			current = undefined
		},
	}
}

describe('a goal whose round was handed back', () => {
	it.each([undefined, 'model', 'record'] as const)(
		'ends not confirmed and blocked with the reason, confirmed by %s',
		async (confirmedBy) => {
			const { store, session, tenantId, confirmation } = await setup(confirmedBy)
			const report = await confirmation.handBack('turn', handBack)
			expect(report).toMatchObject({ ending: 'not-confirmed', handedBack: handBack })
			expect(describeGoalEnding(report ?? { ending: 'not-confirmed', sentence: '' })).toBe(
				'Goal not confirmed: the model handed the task back to a person (a decision is needed that belongs to a person).',
			)
			const goal = await store.getGoal(session.id, tenantId)
			expect(goal?.phase).toBe('blocked')
			expect(JSON.stringify(goal)).toContain('handed-back-to-a-person')
			expect(JSON.stringify(goal)).toContain('two designs fit')
		},
	)

	it('says nothing for a turn that is not a goal round', async () => {
		const { confirmation, drop } = await setup()
		drop()
		expect(await confirmation.handBack('turn', handBack)).toBeUndefined()
	})
})
