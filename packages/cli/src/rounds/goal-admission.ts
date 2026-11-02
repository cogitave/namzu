/**
 * Admitting one automatic goal round.
 *
 * This reserves a round on disk and says what to do about it; it never starts a
 * turn. The caller queues the result behind any person's message that arrived
 * while the disk write was pending, which is what keeps a human prompt ahead of
 * an automatic round. Every `await` is followed by a check that the boundary the
 * reservation was made for still stands, because the person may have started a
 * new conversation, a goal command or a model switch meanwhile.
 */

import {
	type GoalRoundAuthority,
	GoalRoundLimitError,
	type SessionGoalActivation,
	type SessionGoalStore,
	type SessionId,
	StaleGoalError,
	type TenantId,
} from '@namzu/sdk'

import { type QueuedPrompt, goalRoundPrompt } from './types.js'

export type GoalAdmission<Trigger extends string = string> =
	/** Nothing to run: the goal moved on, or the boundary changed, or consent was withdrawn. */
	| { readonly kind: 'none' }
	/** A round was reserved; queue it. */
	| { readonly kind: 'admitted'; readonly round: QueuedPrompt<Trigger> }
	/** The round limit was reached; say so in one plain sentence. */
	| { readonly kind: 'blocked'; readonly message: string }
	/** The admission failed; say so in one plain sentence. */
	| { readonly kind: 'failed'; readonly message: string }

export interface GoalAdmissionDeps {
	readonly goals: SessionGoalStore
	readonly tenantId: TenantId
	readonly sessionId: SessionId
	/** The conversation generation the reservation is made for. */
	readonly generation: number
	readonly activation: SessionGoalActivation
	/** What the person armed: the goal id and revision automatic work may continue. */
	readonly armed: { readonly id: GoalRoundAuthority['id']; readonly revision: number }
	/** Resolves once earlier conversation writes are durable. */
	readonly persistenceTail: () => Promise<unknown>
	/** After the persistence wait: true when a turn or the screen's state now forbids a new round. */
	readonly boundaryChanged: () => boolean
	/** After the disk reservation: true when a conversation, command or switch revoked this boundary. */
	readonly revokedMeanwhile: () => boolean
	/** One plain sentence for an error, ending the first part of "Automatic goal continuation stopped.". */
	readonly explainFailure: (error: unknown) => string
}

export async function admitGoalRound<Trigger extends string = string>(
	deps: GoalAdmissionDeps,
): Promise<GoalAdmission<Trigger>> {
	const { goals, tenantId, sessionId, generation, activation, armed } = deps
	try {
		await deps.persistenceTail()
		if (deps.boundaryChanged() || !activation.isArmed(sessionId, armed)) return { kind: 'none' }

		const current = await goals.getGoal(sessionId, tenantId)
		if (
			!current ||
			current.phase !== 'active' ||
			current.id !== armed.id ||
			current.revision !== armed.revision
		) {
			activation.disarm(sessionId, armed)
			return { kind: 'none' }
		}

		const authority = await goals.admitRound(sessionId, tenantId, armed)
		// Human input may have entered or even started while admission was on
		// disk; keep it. The goal round appends after that FIFO. A conversation
		// or goal command is different: it revoked this scheduling boundary.
		if (deps.revokedMeanwhile() || !activation.isArmed(sessionId, armed)) {
			activation.disarm(sessionId, armed)
			return { kind: 'none' }
		}
		activation.arm(authority)
		return {
			kind: 'admitted',
			round: {
				kind: 'goal',
				text: goalRoundPrompt(authority),
				goalRound: authority,
				generation,
			},
		}
	} catch (error) {
		activation.disarm(sessionId, armed)
		if (error instanceof GoalRoundLimitError) {
			return {
				kind: 'blocked',
				message: `Goal blocked after ${error.goal.roundsAdmitted} admitted round${error.goal.roundsAdmitted === 1 ? '' : 's'}: ${error.goal.blockedReason?.message ?? 'the round limit was reached'}`,
			}
		}
		if (error instanceof StaleGoalError) return { kind: 'none' }
		return {
			kind: 'failed',
			message: `${deps.explainFailure(error)} Run /goal resume to try again.`,
		}
	}
}
