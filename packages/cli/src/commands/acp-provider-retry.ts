import {
	DiskSessionCheckpointStore,
	DiskSessionLog,
	DiskSessionTokenBudgetStore,
	SessionTokenBudget,
	abandonTurn,
	asCheckpointId,
	asSessionId,
	asTurnId,
} from '@namzu/sdk'
import { sessionLogCheckpointView } from '../integrations/sessions/checkpoint-view.js'
import { type CliSessionScope, readConversationFacts } from '../integrations/sessions/store.js'

export interface ProviderRetryStatus {
	/**
	 * The paused turn a Retry would repeat. `original` is the provider and model that failed; Retry
	 * runs on whichever model the conversation has selected now, which may be another one.
	 */
	retry?: {
		turnId: string
		checkpointId: string
		original?: { provider: string; model: string }
	}
	notice?: string
	/**
	 * The turn stopped on a provider failure and waits for no human decision, so sending a new message
	 * may close it first (the same durable close as "Continue without this reply"). Absent when the
	 * turn is waiting for an approval or a handoff: those are the person's to answer, not to skip.
	 */
	closable?: true
	/** How many earlier requests have a cost nobody reported; a retry is a new request. */
	unknownUsage?: number
}

/**
 * Why a turn is closed when the host that ran it is gone. It reads in the journal; the person is
 * told by the transcript ("Stopped because Namzu was closed"), not by this sentence.
 */
export const HOST_GONE_REASON = 'The host that was running this reply went away before it finished.'

/**
 * Settle the active turn of a host that no longer exists: one with no live writer lease that is
 * not paused and never was (a host that went away after writing the turn's start and the person's message, and
 * before anything that settles it). Closing it is one durable append, `turn_failed`, and the
 * person's message stays. A turn another host still holds is a running turn and is left alone,
 * as is a paused one, which waits for a person. Returns whether a turn was closed.
 *
 * The lease is the proof: a live host renews its lease while it runs and gives it back only when
 * the turn ends or the process is told to stop, so a turn that is not paused and has no live lease
 * has nobody running it. Nothing waits for a lease to run out and nothing is guessed from a clock.
 */
export async function settleTurnOfGoneHost(
	state: CliSessionScope,
	sessionId: string,
	close?: (turnId: string, reason: string) => Promise<void>,
): Promise<boolean> {
	const id = asSessionId(sessionId)
	const facts = await readConversationFacts(state, id)
	const active = facts?.activeTurn
	if (!active || active.paused) return false
	// A turn that was paused or resumed once has a checkpoint and a person's choice behind it; it is
	// closed by that choice, never from here.
	if (facts.latestPause(active.turnId) || facts.wasResumed(active.turnId)) return false
	const log = DiskSessionLog.at(state.paths, { sessionId: id })
	const current = await log.activeTurn()
	if (!current || current.turnId !== active.turnId || current.state !== 'interrupted') return false
	try {
		if (close) await close(active.turnId, HOST_GONE_REASON)
		else await abandonTurn(id, asTurnId(active.turnId), HOST_GONE_REASON, { log })
	} catch {
		// A host took the conversation between the read and the append: it is running the turn, or
		// has settled it. The status below says which.
		return false
	}
	return true
}

/** Strict durable eligibility; no provider call, writer claim or budget mutation. */
export async function readProviderRetryStatus(
	state: CliSessionScope,
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
	const pause = facts.latestPause(active.turnId)
	if (!pause) throw new Error('This paused turn has no durable pause record.')
	// Human decisions are not provider retries, even if another failure was recorded later.
	const pending = facts.pendingDecisions(active.turnId)
	const closable: Pick<ProviderRetryStatus, 'closable'> =
		!pause.handoff && pause.providerError && pending.size === 0 ? { closable: true } : {}
	const blocked = (notice: string): ProviderRetryStatus => ({ notice, ...closable })
	if (
		pause.handoff ||
		pause.failure?.retryable !== true ||
		!pause.providerError ||
		!['network', 'server', 'throttle'].includes(pause.providerError.kind)
	)
		return blocked(
			'This turn is paused. Resolve its recorded decision or failure before sending another message.',
		)
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
		return blocked('The paused turn’s checkpoint is unavailable. Its conversation is retained.')
	if (pending.size)
		return blocked('This turn is waiting for a recorded human decision; Retry cannot approve it.')
	const binding = checkpoint.budget?.binding
	if (!binding || binding.rootSessionId !== id || binding.rootTurnId !== active.turnId)
		return blocked(
			'This turn’s original token accounting cannot be verified. Its checkpoint is retained.',
		)
	const budget = await new DiskSessionTokenBudgetStore({ paths: state.paths }).load(binding)
	const account = budget?.accounts.find((account) => account.id === binding.accountId)
	if (!budget || !account)
		return blocked(
			'This turn’s original token accounting is unavailable. Its checkpoint is retained.',
		)
	// Unknown spend stops a retry only where a finite limit could already be exceeded by it.
	// Without a limit it stays recorded (never as zero) and the retry is a new request.
	const live = SessionTokenBudget.restore(budget).account(binding.accountId)
	// A request still in flight under a finite limit was never settled either way.
	if (live.summary().poisoned || live.summary().inFlightRequests > 0)
		return blocked(
			'This provider request has unresolved token usage. Retry requires its actual provider usage receipt; the original turn is retained.',
		)
	if (account.turn?.sessionId !== id || account.turn.turnId !== active.turnId || account.settled)
		return blocked(
			'This paused turn’s original token account is not active. Its checkpoint is retained.',
		)
	if (live.remaining <= 0)
		return blocked(
			'This turn’s original token allowance is exhausted. Retry cannot change that allowance.',
		)
	const started = facts.startedTurn(active.turnId)
	// `turn_started` names the model of the first attempt only. Once the turn was resumed, the pause
	// that stopped it belongs to a later attempt whose model no record carries, so none is claimed.
	const resumed = facts.wasResumed(active.turnId)
	const original =
		!resumed && started?.model && pause.providerError
			? { provider: pause.providerError.providerId, model: started.model }
			: undefined
	return {
		retry: {
			turnId: active.turnId,
			checkpointId: pause.checkpointId,
			...(original ? { original } : {}),
		},
		...closable,
		...(live.summary().unresolvedRequests > 0
			? { unknownUsage: live.summary().unresolvedRequests }
			: {}),
	}
}
