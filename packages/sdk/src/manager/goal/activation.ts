import type { GoalRef, SessionGoal } from '../../types/goal/index.js'
import type { SessionId } from '../../types/ids/index.js'

export interface ActiveSessionGoal extends GoalRef {
	readonly sessionId: SessionId
}

function sameGoal(left: GoalRef, right: GoalRef): boolean {
	return left.id === right.id && left.revision === right.revision
}

/**
 * Process-local permission for automatic goal continuation.
 *
 * Durable `phase: active` describes goal state; it does not grant a restarted
 * process permission to spend another model turn. Hosts arm explicitly after
 * direct create/resume and use exact disarm to keep an old turn from revoking
 * a newer activation.
 */
export class SessionGoalActivation {
	private readonly active = new Map<SessionId, ActiveSessionGoal>()

	arm(goal: Pick<SessionGoal, 'sessionId' | 'id' | 'revision'>): ActiveSessionGoal {
		const armed = Object.freeze({
			sessionId: goal.sessionId,
			id: goal.id,
			revision: goal.revision,
		})
		this.active.set(goal.sessionId, armed)
		return armed
	}

	get(sessionId: SessionId): ActiveSessionGoal | null {
		return this.active.get(sessionId) ?? null
	}

	isArmed(sessionId: SessionId, ref: GoalRef): boolean {
		const active = this.active.get(sessionId)
		return Boolean(active && sameGoal(active, ref))
	}

	/** Disarm unconditionally, or only if the caller still owns the exact ref. */
	disarm(sessionId: SessionId, expected?: GoalRef): boolean {
		const active = this.active.get(sessionId)
		if (!active || (expected && !sameGoal(active, expected))) return false
		return this.active.delete(sessionId)
	}

	clear(): void {
		this.active.clear()
	}
}
