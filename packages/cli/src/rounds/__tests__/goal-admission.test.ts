import {
	type GoalRoundAuthority,
	GoalRoundLimitError,
	type SessionGoal,
	SessionGoalActivation,
	type SessionGoalStore,
	type SessionId,
	StaleGoalError,
	type TenantId,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { type GoalAdmissionDeps, admitGoalRound } from '../goal-admission.js'
import { goalRoundPrompt } from '../types.js'

const sessionId = 's1' as SessionId
const tenantId = 't1' as TenantId
const armedRef = { sessionId, id: 'g1', revision: 2 } as never
const activeGoal = { id: 'g1', revision: 2, phase: 'active' } as unknown as SessionGoal
const authority = {
	sessionId,
	tenantId,
	id: 'g1',
	revision: 3,
	round: 1,
	maxGoalRounds: 5,
	objective: 'ship it',
} as unknown as GoalRoundAuthority

function setup(
	overrides: Partial<{ store: Partial<SessionGoalStore>; deps: Partial<GoalAdmissionDeps> }> = {},
) {
	const activation = new SessionGoalActivation()
	activation.arm({ sessionId, id: 'g1', revision: 2 } as never)
	const log: string[] = []
	const goals = {
		getGoal: async () => activeGoal,
		admitRound: async () => authority,
		...overrides.store,
	} as unknown as SessionGoalStore
	const deps: GoalAdmissionDeps = {
		goals,
		tenantId,
		sessionId,
		generation: 7,
		activation,
		armed: activation.get(sessionId) ?? armedRef,
		persistenceTail: async () => {
			log.push('persisted')
		},
		boundaryChanged: () => false,
		revokedMeanwhile: () => false,
		explainFailure: (error) => `Failed: ${(error as Error).message}.`,
		...overrides.deps,
	}
	return { activation, deps, log }
}

describe('admitGoalRound', () => {
	it('reserves a round and hands back the prompt to queue, re-armed on the new revision', async () => {
		const { activation, deps, log } = setup()
		const result = await admitGoalRound(deps)
		expect(log).toEqual(['persisted'])
		expect(result).toEqual({
			kind: 'admitted',
			round: {
				kind: 'goal',
				text: goalRoundPrompt(authority),
				goalRound: authority,
				generation: 7,
			},
		})
		expect(activation.get(sessionId)?.revision).toBe(3)
	})

	it('does nothing, and keeps consent, when the screen is no longer free after the wait', async () => {
		const { activation, deps } = setup({ deps: { boundaryChanged: () => true } })
		expect(await admitGoalRound(deps)).toEqual({ kind: 'none' })
		expect(activation.get(sessionId)).not.toBeNull()
	})

	it('withdraws consent when the goal on disk is not the one that was armed', async () => {
		const { activation, deps } = setup({
			store: { getGoal: async () => ({ ...activeGoal, revision: 9 }) as SessionGoal },
		})
		expect(await admitGoalRound(deps)).toEqual({ kind: 'none' })
		expect(activation.get(sessionId)).toBeNull()
	})

	it('withdraws consent when the goal is no longer active', async () => {
		const { activation, deps } = setup({
			store: { getGoal: async () => ({ ...activeGoal, phase: 'paused' }) as SessionGoal },
		})
		expect(await admitGoalRound(deps)).toEqual({ kind: 'none' })
		expect(activation.get(sessionId)).toBeNull()
	})

	it('drops a round whose boundary was revoked while it was on disk', async () => {
		const { activation, deps } = setup({ deps: { revokedMeanwhile: () => true } })
		expect(await admitGoalRound(deps)).toEqual({ kind: 'none' })
		expect(activation.get(sessionId)).toBeNull()
	})

	it('says the goal is blocked at the round limit, in one sentence', async () => {
		const goal = {
			...activeGoal,
			maxGoalRounds: 2,
			roundsAdmitted: 2,
			blockedReason: { code: 'round-limit', message: 'No more rounds.' },
		} as unknown as SessionGoal
		const { activation, deps } = setup({
			store: {
				admitRound: async () => {
					throw new GoalRoundLimitError(goal)
				},
			},
		})
		expect(await admitGoalRound(deps)).toEqual({
			kind: 'blocked',
			message: 'Goal blocked after 2 admitted rounds: No more rounds.',
		})
		expect(activation.get(sessionId)).toBeNull()
	})

	it('says "round" for one and falls back when no reason was given', async () => {
		const goal = { ...activeGoal, roundsAdmitted: 1 } as unknown as SessionGoal
		const { deps } = setup({
			store: {
				admitRound: async () => {
					throw new GoalRoundLimitError(goal)
				},
			},
		})
		expect(await admitGoalRound(deps)).toEqual({
			kind: 'blocked',
			message: 'Goal blocked after 1 admitted round: the round limit was reached',
		})
	})

	it('stays silent when the goal changed under the write', async () => {
		const { activation, deps } = setup({
			store: {
				admitRound: async () => {
					throw new StaleGoalError({ sessionId, expectedRevision: 2, actualRevision: 3 })
				},
			},
		})
		expect(await admitGoalRound(deps)).toEqual({ kind: 'none' })
		expect(activation.get(sessionId)).toBeNull()
	})

	it('says any other failure plainly and how to try again', async () => {
		const { activation, deps } = setup({
			store: {
				admitRound: async () => {
					throw new Error('disk is full')
				},
			},
		})
		expect(await admitGoalRound(deps)).toEqual({
			kind: 'failed',
			message: 'Failed: disk is full. Run /goal resume to try again.',
		})
		expect(activation.get(sessionId)).toBeNull()
	})
})
