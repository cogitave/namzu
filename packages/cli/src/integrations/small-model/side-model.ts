/**
 * A tool-free request on the small model, for jobs beside the conversation.
 *
 * Two promises hold for every caller, and they are why this is one place:
 *
 * - **It never blocks or fails a turn.** `ask` resolves `undefined` on any
 *   failure: no credential for the small model's provider, a listing that
 *   does not answer, a request that errors or is cancelled, a reply that is
 *   empty. The caller then does what it did before the job existed.
 * - **Its tokens are counted.** A side request is spend of the turn it
 *   belongs to, so it is charged to that turn's ledger through the
 *   {@link SideLedger} the host gives, the way a live label already is.
 *   A caller that cannot count a request does not run it.
 *
 * The route (see `route.ts`) is resolved once per conversation model and
 * kept; the provider listing it reads is bounded and cached with it, so a
 * conversation pays for the lookup at most once per model switch.
 */

import {
	type LLMProvider,
	type ModelInfo,
	type SessionId,
	type TokenUsage,
	type TurnId,
	collectChatCompletion,
	createSystemMessage,
	createUserMessage,
} from '@namzu/sdk'
import { runPickerProviderOperation } from '../providers/picker-operation.js'
import {
	type SideModelTarget,
	type SideRoute,
	cheapestTextModel,
	parseSmallModel,
} from './route.js'

/** Where a side request is counted. Implemented by the delegation runtime, which owns the turn's ledger. */
export interface SideLedger {
	/**
	 * Admit `request` on the turn's ledger, run it, and count what it used.
	 * Resolves `undefined`, without running it, when the turn has no ledger to
	 * count it on or no room for it.
	 */
	chargeNow<T>(input: {
		readonly turnId: TurnId
		readonly sessionId: SessionId
		readonly estimatedPromptTokens: number
		readonly signal: AbortSignal
		readonly request: () => Promise<{
			readonly value: T
			readonly usage: TokenUsage
		}>
	}): Promise<T | undefined>
	/**
	 * Count a request that already ran. The turn's own request holds the
	 * ledger while it is open, so this is applied when the turn is released if
	 * it cannot be applied now. Settles once the request is counted or, for a
	 * turn still open, queued; it never rejects.
	 */
	chargeLater(input: {
		readonly turnId: TurnId
		readonly sessionId: SessionId
		readonly estimatedPromptTokens: number
		readonly usage: TokenUsage
	}): Promise<void>
}

export interface SideModelDeps {
	/** The provider and model the conversation runs on right now. */
	readonly active: () => SideModelTarget
	/** `NamzuCliConfig.smallModel`. */
	readonly configured?: string | undefined
	readonly isKnownProvider: (providerId: string) => boolean
	/** A provider for `target`; rejects when the machine has no credential for it. */
	readonly buildProvider: (sessionId: SessionId, target: SideModelTarget) => Promise<LLMProvider>
	/** Whether a listed model may be chosen (the same rule the model picker applies). */
	readonly offerable?: (providerId: string, model: ModelInfo) => boolean
	readonly ledger: SideLedger
	/** Where a failure that was swallowed is noted. */
	readonly debug?: (message: string, error: unknown) => void
}

export interface SideRequest {
	readonly sessionId: SessionId
	/** The turn this request belongs to: its ledger is charged. */
	readonly turnId: TurnId
	readonly instruction: string
	readonly body: string
	readonly maxTokens: number
	readonly signal: AbortSignal
	/**
	 * `in-turn` runs the request on the turn's ledger and is declined when the
	 * ledger has no room. `beside-turn` runs now, in parallel with the turn's
	 * own request, and is counted once that request has closed.
	 */
	readonly timing: 'in-turn' | 'beside-turn'
}

/** A small model and a provider already built for it, for a caller that makes the call itself. */
export interface SideProvider {
	readonly provider: LLMProvider
	readonly providerId: string
	readonly model: string
}

export interface SideModel {
	/** The route a side request would take now. Never throws. */
	route(sessionId: SessionId, signal: AbortSignal): Promise<SideRoute>
	/**
	 * The small model's provider, for a caller that sends its own request and
	 * counts its own tokens. Resolves `undefined` when no small model is set
	 * aside (the route fell back to the conversation's own model) or no
	 * credential reaches it; never throws.
	 */
	smallProvider(sessionId: SessionId, signal: AbortSignal): Promise<SideProvider | undefined>
	/** The reply text, or `undefined` when the request could not be made or counted. */
	ask(request: SideRequest): Promise<string | undefined>
}

/** A rough size in tokens, for admission and for a cancelled request. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

export function createSideModel(deps: SideModelDeps): SideModel {
	const routes = new Map<string, Promise<SideRoute>>()

	const resolve = async (sessionId: SessionId, signal: AbortSignal): Promise<SideRoute> => {
		const active = deps.active()
		if (deps.configured !== undefined) {
			const target = parseSmallModel(deps.configured, active.providerId, deps.isKnownProvider)
			return { ...target, source: 'configured' }
		}
		try {
			const provider = await deps.buildProvider(sessionId, active)
			if (provider.listModels === undefined) return { ...active, source: 'main' }
			const listing = await runPickerProviderOperation(signal, (operationSignal) =>
				(provider.listModels as (signal?: AbortSignal) => Promise<ModelInfo[]>)(operationSignal),
			)
			const cheapest = cheapestTextModel(active.providerId, listing, (model) =>
				deps.offerable ? deps.offerable(active.providerId, model) : true,
			)
			if (cheapest !== undefined) {
				return {
					providerId: active.providerId,
					model: cheapest.id,
					source: 'cheapest',
				}
			}
		} catch (error) {
			deps.debug?.('side model: listing failed, using the conversation model', error)
		}
		return { ...active, source: 'main' }
	}

	const route = (sessionId: SessionId, signal: AbortSignal): Promise<SideRoute> => {
		const active = deps.active()
		const key = `${active.providerId}\n${active.model}\n${deps.configured ?? ''}`
		let pending = routes.get(key)
		if (pending === undefined) {
			pending = resolve(sessionId, signal)
			routes.set(key, pending)
			// A lookup that the caller cancelled says nothing about the models:
			// forget it so the next request asks again.
			void pending.then((value) => {
				if (signal.aborted && value.source === 'main' && routes.get(key) === pending) {
					routes.delete(key)
				}
			})
		}
		return pending
	}

	const ask = async (request: SideRequest): Promise<string | undefined> => {
		try {
			request.signal.throwIfAborted()
			const chosen = await route(request.sessionId, request.signal)
			const provider = await deps.buildProvider(request.sessionId, chosen)
			const estimatedPromptTokens =
				estimateTokens(request.instruction) + estimateTokens(request.body)
			const send = async () => {
				const response = await collectChatCompletion(
					provider.chatStream({
						model: chosen.model,
						messages: [createSystemMessage(request.instruction), createUserMessage(request.body)],
						maxTokens: request.maxTokens,
						signal: request.signal,
					}),
				)
				return { value: response.message.content ?? '', usage: response.usage }
			}
			if (request.timing === 'in-turn') {
				const text = await deps.ledger.chargeNow({
					turnId: request.turnId,
					sessionId: request.sessionId,
					estimatedPromptTokens,
					signal: request.signal,
					request: send,
				})
				return text?.trim() ? text : undefined
			}
			const result = await send()
			void deps.ledger.chargeLater({
				turnId: request.turnId,
				sessionId: request.sessionId,
				estimatedPromptTokens,
				usage: result.usage,
			})
			return result.value.trim() ? result.value : undefined
		} catch (error) {
			deps.debug?.('side model: request failed', error)
			return undefined
		}
	}

	const smallProvider = async (
		sessionId: SessionId,
		signal: AbortSignal,
	): Promise<SideProvider | undefined> => {
		try {
			const chosen = await route(sessionId, signal)
			if (chosen.source === 'main') return undefined
			const provider = await deps.buildProvider(sessionId, chosen)
			return { provider, providerId: chosen.providerId, model: chosen.model }
		} catch (error) {
			deps.debug?.('side model: no provider for the small model', error)
			return undefined
		}
	}

	return { route, ask, smallProvider }
}
