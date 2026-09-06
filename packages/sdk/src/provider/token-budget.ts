import { EMPTY_TOKEN_USAGE } from '../constants/limits.js'
import type { TokenBudget } from '../run/token-budget.js'
import { type TokenUsage, mergeTokenUsage } from '../types/common/index.js'
import { ProviderError, classifyProviderError } from '../types/provider/errors.js'
import type { LLMProvider, StreamChunk } from '../types/provider/index.js'
import { isProviderRequestError } from './errors.js'

export class TokenBudgetAdmissionError extends ProviderError {
	constructor() {
		super({
			code: 'invalid_request',
			message: 'The shared token budget has no available allowance for another model request.',
			retryable: false,
		})
		this.name = 'TokenBudgetAdmissionError'
	}
}

function rejectedBeforeGeneration(error: unknown): boolean {
	if (isProviderRequestError(error)) {
		return ['auth', 'throttle', 'context_overflow', 'bad_request'].includes(error.kind)
	}
	const classified = classifyProviderError(error)
	const explicitRejection =
		error instanceof ProviderError ||
		(classified.status !== undefined &&
			[400, 401, 403, 404, 413, 422, 429].includes(classified.status))
	return (
		explicitRejection &&
		['auth', 'rate_limit', 'context_length_exceeded', 'invalid_request', 'not_found'].includes(
			classified.code,
		)
	)
}

/** Account for the observed response once, including advisory/compaction calls.
 * The marker is durable before contacting the provider. A broken or abandoned
 * stream retains its marker: an absent receipt cannot establish zero spend.
 * Driver-internal retries remain one request whose billing the driver reports.
 */
export function withTokenBudget(provider: LLMProvider, budget: TokenBudget): LLMProvider {
	async function* chatStream(
		params: Parameters<LLMProvider['chatStream']>[0],
	): AsyncIterable<StreamChunk> {
		params.signal?.throwIfAborted()
		if (budget.remaining <= 0) throw new TokenBudgetAdmissionError()
		const requestId = await budget.beginRequest()
		let usage: TokenUsage | undefined
		let completed = false
		let outputObserved = false
		let uncertainRetry = false
		let contacted = false
		let abandoned = false
		let iterator: AsyncIterator<StreamChunk> | undefined
		let onAbort: (() => void) | undefined
		const signal = params.signal
		const cancellation = signal
			? new Promise<never>((_resolve, reject) => {
					onAbort = () => {
						abandoned = true
						reject(signal.reason)
					}
					signal.addEventListener('abort', onAbort, { once: true })
				})
			: undefined
		// Admission persistence can have outlived the caller's authority. The
		// check below may reject before the first pull attaches a race handler.
		cancellation?.catch(() => {})
		try {
			signal?.throwIfAborted()
			contacted = true
			iterator = provider.chatStream(params)[Symbol.asyncIterator]()
			for (;;) {
				signal?.throwIfAborted()
				const next = iterator.next()
				// Observe an already-issued pull even after cancellation wins the
				// race. A late usage frame is evidence of spend, not permission to
				// reopen the account or to request another frame.
				void next
					.then(async (result) => {
						if (!result.done && result.value.usage) {
							usage = usage ? mergeTokenUsage(usage, result.value.usage) : { ...result.value.usage }
							if (abandoned) await budget.failRequest(requestId, usage)
						}
					})
					.catch(() => {})
				const result = await (cancellation ? Promise.race([next, cancellation]) : next)
				if (result.done) break
				const chunk = result.value
				const recovery = chunk.retry ?? chunk.fallback
				if (
					recovery &&
					![
						'auth',
						'rate_limit',
						'context_length_exceeded',
						'invalid_request',
						'not_found',
					].includes(recovery.code)
				) {
					uncertainRetry = true
					throw new ProviderError({
						code: 'invalid_request',
						retryable: false,
						message:
							'A prior provider attempt has unresolved token usage; another attempt cannot be admitted.',
					})
				}
				if (Object.keys(chunk.delta).length > 0) outputObserved = true
				if (chunk.error) throw new Error(chunk.error)
				yield chunk
			}
			if (usage === undefined) {
				throw new Error(
					'Provider ended without token usage; the budget reservation remains unresolved.',
				)
			}
			await budget.finishRequest(requestId, usage)
			completed = true
		} catch (error) {
			// A typed rejection before any generation differs from a lost reply.
			// In particular a context-overflow retry must not reset or poison spend.
			if (
				!contacted ||
				(!abandoned &&
					!outputObserved &&
					usage === undefined &&
					!uncertainRetry &&
					rejectedBeforeGeneration(error))
			) {
				await budget.finishRequest(requestId, { ...EMPTY_TOKEN_USAGE })
				completed = true
			}
			throw error
		} finally {
			abandoned = !completed
			if (onAbort) signal?.removeEventListener('abort', onAbort)
			// A blocked async generator queues return() behind its pending next().
			// Waiting for it would also delay the durable unknown-spend marker.
			try {
				void iterator?.return?.().catch(() => {})
			} catch {
				// Cleanup cannot replace the provider outcome.
			}
			if (!completed) await budget.failRequest(requestId, usage)
		}
	}

	// Bind optional driver methods to the driver, including methods added later.
	// Object spread loses prototype methods and inherited capability accessors.
	return new Proxy(provider, {
		get(target, property) {
			if (property === 'chatStream') return chatStream
			const value: unknown = Reflect.get(target, property, target)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}
