import {
	type SessionTokenBudget,
	type SessionTokenBudgetStore,
	openSessionTokenBudget,
} from '../../store/budget/index.js'
import type { TurnId } from '../../types/ids/index.js'
import type { TurnBudgetBinding } from '../../types/session/turn.js'
import { asSessionId, asTurnId } from '../../utils/id.js'
import type { QueryParams } from './index.js'

/** The ledger reference a checkpoint (or a selected resume state) carries. */
export interface SavedBudgetReference {
	readonly binding?: TurnBudgetBinding
	readonly accountId?: string
}

/**
 * Resolve one ledger authority before any model request or recovered tool
 * dispatch.
 *
 * The ledger is keyed by `(rootSessionId, rootTurnId)`: a root turn opens its
 * own ledger with its own limit; a child session's turns bind to the key of
 * the root turn that spawned them (they are handed that account); a resumed
 * paused turn reuses its key. A limit that changes between two turns of one
 * session is therefore two ledgers, never a mismatch.
 */
export async function resolveQueryBudget(
	params: QueryParams,
	turnId: TurnId,
	store: SessionTokenBudgetStore,
	saved?: SavedBudgetReference,
): Promise<SessionTokenBudget> {
	const schedulerBudget = params.taskScheduler?.budget
	if (params.taskScheduler && !schedulerBudget) {
		throw new Error('A task scheduler must expose its shared token budget account.')
	}
	if (params.budget && schedulerBudget && params.budget !== schedulerBudget) {
		throw new Error('Query and task scheduler must share the same token budget account.')
	}
	const provided = params.budget ?? schedulerBudget
	const binding = saved?.binding === undefined ? undefined : validateBinding(saved.binding)
	if (binding && saved?.accountId !== undefined && saved.accountId !== binding.accountId) {
		throw new Error('Checkpoint token budget account references disagree.')
	}
	if (provided) {
		if (saved?.accountId && saved.accountId !== provided.accountId) {
			throw new Error('Resume requires the original token budget account.')
		}
		if (
			binding &&
			(binding.accountId !== provided.accountId ||
				binding.rootSessionId !== provided.scope.rootSessionId ||
				binding.rootTurnId !== provided.scope.rootTurnId)
		) {
			throw new Error('Checkpoint and supplied token budget authority disagree.')
		}
		provided.bindTurn(params.sessionId, turnId)
		narrowToTurnLimit(provided, params.turnConfig.tokenBudget)
		return provided
	}
	if (saved?.accountId && !binding) {
		throw new Error(
			'This checkpoint used an in-memory token budget. Supply its current authoritative budget to resume.',
		)
	}
	const ownRoot = binding === undefined || binding.rootTurnId === turnId
	const budget = await openSessionTokenBudget({
		store,
		scope: binding
			? { rootSessionId: binding.rootSessionId, rootTurnId: binding.rootTurnId }
			: { rootSessionId: params.sessionId, rootTurnId: turnId },
		...(ownRoot ? { limit: params.turnConfig.tokenBudget } : {}),
		...(binding ? { accountId: binding.accountId, requireExisting: true } : {}),
	})
	budget.bindTurn(params.sessionId, turnId)
	narrowToTurnLimit(budget, params.turnConfig.tokenBudget)
	return budget
}

function validateBinding(binding: TurnBudgetBinding): TurnBudgetBinding {
	if (typeof binding.accountId !== 'string' || binding.accountId.length === 0) {
		throw new Error('Checkpoint token budget binding has no account.')
	}
	return {
		rootSessionId: asSessionId(binding.rootSessionId),
		rootTurnId: asTurnId(binding.rootTurnId),
		accountId: binding.accountId,
	}
}

function narrowToTurnLimit(budget: SessionTokenBudget, limit: number): void {
	if (limit > 0 && (budget.limit === 0 || limit < budget.limit)) budget.narrow(limit)
}
