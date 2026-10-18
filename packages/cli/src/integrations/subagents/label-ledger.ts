/**
 * Where the tokens of a live-label request are counted.
 *
 * The label of a running agent (`activity-label.ts`) is one more provider
 * request the turn causes, and the turn's token ledger is the account of what a
 * turn spends. A request made outside it would be spend the person's limit
 * never sees. The reference counts these requests with the rest of the session
 * (its `agent_summary` calls go through the same cost tracker), so this does
 * too, with the ledger's own public API and no addition to it:
 *
 * - a small allowance is reserved from the turn's root account for the one
 *   request, as a child account bound to its own turn id, so it can run beside
 *   the agents and the parent's own request;
 * - the request is opened on that account and closed with the usage the
 *   provider reported;
 * - the account is settled either way, which hands what it did not spend back.
 *
 * It never blocks real work. A label is skipped when the turn's allowance is
 * nearly gone or the root account is busy with a request of its own, and a
 * request that fails is closed as spending nothing rather than as unknown
 * spend, which would stop every later request of a limited turn.
 */

import {
	type SessionId,
	type SessionTokenBudget,
	type TokenUsage,
	generateTurnId,
} from '@namzu/sdk'

/** Most one label request may use from a limited turn. */
export const LABEL_REQUEST_ALLOWANCE_TOKENS = 8_000

const NOTHING: TokenUsage = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** What the request produced and what the provider said it cost. */
export interface LabelRequestResult<T> {
	readonly value: T
	readonly usage: TokenUsage
}

/**
 * Runs `request` against a reserved account of `budget`, and counts it.
 *
 * `estimatedPromptTokens` is what is charged when the request is cancelled
 * after it was sent and no usage came back, the way the SDK charges a request
 * the person cancelled. Resolves `undefined` when there was no room for it.
 */
export async function chargeLabelRequest<T>(input: {
	readonly budget: SessionTokenBudget
	readonly sessionId: SessionId
	readonly estimatedPromptTokens: number
	readonly signal: AbortSignal
	readonly request: () => Promise<LabelRequestResult<T>>
}): Promise<T | undefined> {
	const { budget, sessionId, signal } = input
	let account: SessionTokenBudget
	try {
		const remaining = budget.remaining
		const limited = Number.isFinite(remaining)
		const allowance = limited ? Math.min(remaining, LABEL_REQUEST_ALLOWANCE_TOKENS) : 0
		if (limited && allowance < input.estimatedPromptTokens) return undefined
		account = budget.reserve(allowance)
		try {
			account.bindTurn(sessionId, generateTurnId())
		} catch (error) {
			account.settle()
			throw error
		}
	} catch {
		// The root account has a request of its own in flight, or the turn's
		// allowance is spoken for: try again at the next interval.
		return undefined
	}
	let requestId: string
	try {
		requestId = await account.beginRequest()
	} catch {
		account.settle()
		return undefined
	}
	try {
		const result = await input.request()
		await account.finishRequest(requestId, result.usage)
		return result.value
	} catch (error) {
		const cancelled = signal.aborted
		const prompt = cancelled ? Math.max(0, Math.ceil(input.estimatedPromptTokens)) : 0
		await account
			.finishRequest(requestId, {
				...NOTHING,
				promptTokens: prompt,
				totalTokens: prompt,
			})
			.catch(() => undefined)
		throw error
	} finally {
		account.settle()
	}
}
