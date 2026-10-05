import {
	DiskSessionCheckpointStore,
	DiskSessionLog,
	DiskSessionTokenBudgetStore,
	SessionTokenBudget,
	asCheckpointId,
	asSessionId,
	asTurnId,
} from '@namzu/sdk'
import { sessionLogCheckpointView } from '../integrations/sessions/checkpoint-view.js'
import { type CliSessions, readConversationFacts } from '../integrations/sessions/store.js'

export interface ProviderRetryStatus {
	retry?: { turnId: string; checkpointId: string }
	notice?: string
}

/** Strict durable eligibility; no provider call, writer claim or budget mutation. */
export async function readProviderRetryStatus(
	state: CliSessions,
	sessionId: string,
): Promise<ProviderRetryStatus> {
	const id = asSessionId(sessionId)
	const facts = await readConversationFacts(state, id)
	if (!facts) return {}
	if (
		facts.started.tenantId !== state.tenantId ||
		facts.started.projectId !== state.projectId ||
		facts.started.sessionId !== id ||
		facts.archived
	)
		throw new Error('This conversation does not belong to this active project.')
	const active = facts.activeTurn
	if (!active) return {}
	if (!active.paused) return { notice: 'Wait for this conversation’s active turn to settle.' }
	const pause = [...facts.records]
		.reverse()
		.find((record) => record.type === 'turn_paused' && record.turnId === active.turnId)
	if (!pause || pause.type !== 'turn_paused')
		throw new Error('This paused turn has no durable pause record.')
	if (
		pause.handoff ||
		pause.failure?.retryable !== true ||
		!pause.providerError ||
		!['network', 'server', 'throttle'].includes(pause.providerError.kind)
	)
		return {
			notice:
				'This turn is paused. Resolve its recorded decision or failure before sending another message.',
		}
	const scope = {
		tenantId: state.tenantId,
		projectId: state.projectId,
		sessionId: id,
		turnId: asTurnId(active.turnId),
	}
	const log = DiskSessionLog.at(state.paths, { sessionId: id })
	const checkpoints = new DiskSessionCheckpointStore({
		paths: state.paths,
		log: sessionLogCheckpointView(log),
	})
	const checkpoint = await checkpoints.restore(scope, asCheckpointId(pause.checkpointId))
	if (!checkpoint)
		return { notice: 'The paused turn’s checkpoint is unavailable. Its conversation is retained.' }
	// Human decisions are not provider retries, even if another failure was recorded later.
	const pending = new Set<string>()
	for (const record of facts.records) {
		if (record.type === 'decision_requested' && record.turnId === active.turnId)
			pending.add(record.decisionId)
		if (record.type === 'decision_resolved' || record.type === 'decision_expired')
			pending.delete(record.decisionId)
	}
	if (pending.size)
		return {
			notice: 'This turn is waiting for a recorded human decision; Retry cannot approve it.',
		}
	const binding = checkpoint.budget?.binding
	if (!binding || binding.rootSessionId !== id || binding.rootTurnId !== active.turnId)
		return {
			notice:
				'This turn’s original token accounting cannot be verified. Its checkpoint is retained.',
		}
	const budget = await new DiskSessionTokenBudgetStore({ paths: state.paths }).load(binding)
	const account = budget?.accounts.find((account) => account.id === binding.accountId)
	if (!budget || !account)
		return {
			notice: 'This turn’s original token accounting is unavailable. Its checkpoint is retained.',
		}
	if (
		budget.poisoned ||
		budget.requests.length > 0 ||
		budget.completedRequests.some((request) => request.unresolved)
	)
		return {
			notice:
				'This provider request has unresolved token usage. Retry requires its actual provider usage receipt; the original turn is retained.',
		}
	if (account.turn?.sessionId !== id || account.turn.turnId !== active.turnId || account.settled)
		return {
			notice:
				'This paused turn’s original token account is not active. Its checkpoint is retained.',
		}
	if (SessionTokenBudget.restore(budget).account(binding.accountId).remaining <= 0)
		return {
			notice:
				'This turn’s original token allowance is exhausted. Retry cannot change that allowance.',
		}
	return { retry: { turnId: active.turnId, checkpointId: pause.checkpointId } }
}
