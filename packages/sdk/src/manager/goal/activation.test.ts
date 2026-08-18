import { describe, expect, it } from 'vitest'

import type { SessionGoal } from '../../types/goal/index.js'
import { asGoalId, asSessionId, asTenantId } from '../../utils/id.js'
import { SessionGoalActivation } from './activation.js'

function goal(revision: number): SessionGoal {
	return {
		id: asGoalId('goal_activation'),
		sessionId: asSessionId('ses_activation'),
		tenantId: asTenantId('tnt_activation'),
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
