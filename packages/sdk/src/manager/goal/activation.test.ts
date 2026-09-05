import { describe, expect, it } from 'vitest'

import type { SessionGoal } from '../../types/goal/index.js'
import { asGoalId, asSessionId, asTenantId } from '../../utils/id.js'
import { SessionGoalActivation } from './activation.js'

function goal(revision: number): SessionGoal {
	return {
		id: asGoalId('1a16aa34-d9e2-4205-9eb5-6673e85b1aa3'),
		sessionId: asSessionId('c4455024-5b00-4a2e-af8e-e1441af216af'),
		tenantId: asTenantId('906303b7-9b60-4a9c-9e2f-7893f01d0b9d'),
		revision,
		objective: 'finish',
		phase: 'active',
		maxGoalRounds: 8,
		roundsAdmitted: revision - 1,
		createdAt: 1,
		updatedAt: revision,
	}
}

describe('SessionGoalActivation', () => {
	it('is process-local and exact-revision scoped', () => {
		const activation = new SessionGoalActivation()
		const first = activation.arm(goal(1))
		expect(activation.get(first.sessionId)).toEqual(first)
		expect(activation.isArmed(first.sessionId, first)).toBe(true)
		expect(activation.isArmed(first.sessionId, goal(2))).toBe(false)
	})

	it('does not let an old turn disarm a newer admission', () => {
		const activation = new SessionGoalActivation()
		const old = activation.arm(goal(1))
		const current = activation.arm(goal(2))

		expect(activation.disarm(old.sessionId, old)).toBe(false)
		expect(activation.get(current.sessionId)).toEqual(current)
		expect(activation.disarm(current.sessionId, current)).toBe(true)
		expect(activation.get(current.sessionId)).toBeNull()
	})
})
