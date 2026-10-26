import type { LearningModel, SessionId, TokenUsage, TurnId } from '@namzu/sdk'
import { generateTurnId } from '@namzu/sdk'
import type { SideLedger, SideModel } from '../small-model/side-model.js'

/**
 * The model the built-in generator uses: the same route a side request takes
 * (the configured small model, else the cheapest text model, else the
 * conversation's own), through the configured provider. It counts what each
 * call used, because the learning cycle's allowance is spent from those counts.
 *
 * Calls run one at a time. The counted usage of a call is read straight after
 * the call, so two calls in flight at once could swap their counts.
 */
export interface SideLearningModel {
	readonly model: LearningModel
	/** `provider/model` of the route a call would take now, for the evaluation's conditions. */
	readonly route: (signal: AbortSignal) => Promise<string>
}

/** The ledger a learning side model hands to `createSideModel`: it runs the request and keeps its usage. */
export function createLearningLedger(): SideLedger & { take(): TokenUsage | undefined } {
	let last: TokenUsage | undefined
	return {
		async chargeNow(input) {
			const { value, usage } = await input.request()
			last = usage
			return value
		},
		async chargeLater() {},
		take() {
			const usage = last
			last = undefined
			return usage
		},
	}
}

export function createSideLearningModel(options: {
	readonly side: SideModel
	readonly ledger: ReturnType<typeof createLearningLedger>
	readonly sessionId: SessionId
}): SideLearningModel {
	let queue: Promise<unknown> = Promise.resolve()
	const model: LearningModel = (request) => {
		const run = async () => {
			request.signal.throwIfAborted()
			options.ledger.take()
			const text = await options.side.ask({
				sessionId: options.sessionId,
				turnId: generateTurnId() as TurnId,
				instruction: request.system,
				body: request.prompt,
				maxTokens: request.maxTokens,
				signal: request.signal,
				timing: 'in-turn',
			})
			const usage = options.ledger.take()
			request.signal.throwIfAborted()
			if (text === undefined) throw new Error('The model did not answer the learning request.')
			// A reply with no reported total is unmeasured, never free.
			return { text, tokens: usage ? usage.totalTokens : null, costUsd: null }
		}
		const next = queue.then(run, run)
		queue = next.catch(() => {})
		return next
	}
	return {
		model,
		route: async (signal) => {
			const route = await options.side.route(options.sessionId, signal)
			return `${route.providerId}/${route.model}`
		},
	}
}
