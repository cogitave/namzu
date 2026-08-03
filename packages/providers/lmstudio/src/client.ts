import { randomUUID } from 'node:crypto'
import { LMStudioClient } from '@lmstudio/sdk'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	TokenUsage,
} from '@namzu/sdk'
import {
	ProviderRequestError,
	isCallerAbortError,
	isProviderRequestError,
	providerVendorError,
} from '@namzu/sdk'
import { toolResultToText } from '@namzu/sdk'
import type { LMStudioConfig } from './types.js'

type StopReason =
	| 'eosFound'
	| 'userStopped'
	| 'modelUnloaded'
	| 'failed'
	| 'maxPredictedTokensReached'
	| 'contextLengthReached'
	| 'toolCalls'

function mapStopReason(reason: string | undefined): ChatCompletionResponse['finishReason'] {
	switch (reason as StopReason) {
		case 'maxPredictedTokensReached':
		case 'contextLengthReached':
			return 'length'
		case 'toolCalls':
			return 'tool_calls'
		default:
			return 'stop'
	}
}

function mapUsage(stats: {
	promptTokensCount?: number
	predictedTokensCount?: number
	totalTokensCount?: number
}): TokenUsage {
	const promptTokens = stats.promptTokensCount ?? 0
	const completionTokens = stats.predictedTokensCount ?? 0
	return {
		promptTokens,
		completionTokens,
		totalTokens: stats.totalTokensCount ?? promptTokens + completionTokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

type LMStudioRole = 'system' | 'user' | 'assistant'

export function toLMStudioChat(
	messages: ChatCompletionParams['messages'],
): Array<{ role: LMStudioRole; content: string }> {
	return messages.map((m) => {
		const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
		const role: LMStudioRole = m.role === 'system' || m.role === 'assistant' ? m.role : 'user'
		// Tool messages aren't first-class in this chat API; fold as user
		// content with a marker. The content goes through the SDK's degrade
		// helper rather than a JSON dump, so a result carrying an image
		// arrives as a named placeholder instead of a wall of base64 the
		// model pays for and cannot read.
		if (m.role === 'tool') {
			return { role: 'user', content: `[tool-result] ${toolResultToText(m.content ?? '')}` }
		}
		return { role, content }
	})
}

function normalizeBaseUrl(host: string | undefined): string | undefined {
	if (!host) return undefined
	// LM Studio SDK requires ws:// or wss://. Accept http(s) for ergonomics and convert.
	return host.replace(/^http(s?):\/\//, 'ws$1://')
}

/**
 * Make the SDK's model-resolution await obey the caller signal too.
 *
 * LM Studio accepts a signal only on `model.respond()`, but resolving the model
 * proxy is itself asynchronous. Without this race, Stop could fire while
 * `llm.model()` hung and the provider would not return until the vendor did.
 */
async function awaitRequestStart<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation

	let onAbort: (() => void) | undefined
	const aborted = new Promise<never>((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason)
			return
		}
		onAbort = () => reject(signal.reason)
		signal.addEventListener('abort', onAbort, { once: true })
	})

	// The vendor promise can settle after the abort wins. Promise.race installs
	// a rejection handler, and this explicit sink documents/guards that loser.
	operation.catch(() => undefined)
	try {
		return await Promise.race([operation, aborted])
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort)
	}
}

/**
 * What this DRIVER does, not what LM Studio could do: `chatStream`
 * never reads `params.tools` (tool messages are folded into user text
 * with a `[tool-result]` marker) and `toLMStudioChat` maps text content
 * only (image `attachments` are dropped). Flip these only alongside
 * the corresponding mapping code.
 */
export const LMSTUDIO_CAPABILITIES: ProviderCapabilities = {
	supportsTools: false,
	supportsStreaming: true,
	supportsFunctionCalling: false,
	supportsVision: false,
	// Images only. A document degrades to a named placeholder.
	supportsDocuments: false,
}

/**
 * Compose a caller's cancellation with a configured deadline.
 *
 * Composed rather than replaced: the caller's signal is how a run cancels
 * mid-generation, and dropping it for the deadline would leave a local model
 * generating after the run that asked for it has stopped.
 */
function withDeadline(
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): AbortSignal | undefined {
	if (timeoutMs === undefined) return signal
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error(
			`LM Studio timeout must be a positive number of milliseconds, got ${timeoutMs}. A zero or negative deadline would abort every request before it was sent.`,
		)
	}
	const deadline = AbortSignal.timeout(timeoutMs)
	return signal ? AbortSignal.any([signal, deadline]) : deadline
}

export class LMStudioProvider implements LLMProvider {
	readonly id = 'lmstudio'
	readonly name = 'LM Studio'
	readonly capabilities = LMSTUDIO_CAPABILITIES

	/**
	 * Built on FIRST USE, not in the constructor.
	 *
	 * `new LMStudioClient(...)` opens a websocket to the local LM Studio
	 * immediately, so constructing this provider — which the registry does for
	 * every configured provider, used or not — reached out to a service that is
	 * usually not running, and the connection failure surfaced as an unhandled
	 * rejection nobody owned. Deferring it means a provider that is never asked
	 * for a completion never opens a socket.
	 */
	private clientInstance?: LMStudioClient
	private readonly baseUrl?: string
	private defaultModel?: string
	private readonly timeoutMs?: number

	constructor(config: LMStudioConfig = {}) {
		const baseUrl = normalizeBaseUrl(config.host ?? process.env.LMSTUDIO_HOST)
		if (baseUrl) this.baseUrl = baseUrl
		this.defaultModel = config.model
		if (config.timeout !== undefined) this.timeoutMs = config.timeout
	}

	private get client(): LMStudioClient {
		if (!this.clientInstance) {
			this.clientInstance = new LMStudioClient(this.baseUrl ? { baseUrl: this.baseUrl } : {})
		}
		return this.clientInstance
	}

	private resolveModel(params: ChatCompletionParams): string {
		const model = params.model || this.defaultModel
		if (!model) {
			throw new Error(
				'LMStudioProvider: model is required. Pass `model` in config or on the chat call.',
			)
		}
		return model
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const modelId = this.resolveModel(params)
		try {
			params.signal?.throwIfAborted()

			// The caller's signal and the configured deadline, composed rather
			// than one replacing the other. `LMStudioConfig.timeout` was
			// declared and read by nothing, so a host that set one waited
			// forever anyway — and the wait it exists for is specific: the
			// websocket connects, the model is still loading into memory, and
			// `llm.model()` never resolves.
			const signal = withDeadline(params.signal, this.timeoutMs)
			const model = await awaitRequestStart(this.client.llm.model(modelId), signal)
			// Pass the caller abort so the SDK sends the real server-side cancel
			// (LLMPredictionOpts.signal → websocket cancel). `.return()` from the
			// for-await alone does NOT cancel the prediction, so without this a Stop
			// leaves the local model generating. No-op when the signal never aborts.
			const prediction = model.respond(toLMStudioChat(params.messages), {
				signal,
			})

			const id = randomUUID()
			let sawContent = false
			for await (const fragment of prediction) {
				// Cheap promptness check between fragments (the signal above is the
				// real teardown).
				params.signal?.throwIfAborted()
				if (fragment.content) {
					sawContent = true
					yield {
						id,
						delta: { content: fragment.content },
					}
				}
			}

			const result = await prediction

			// `contextLengthReached` with NO content is not a truncated answer the
			// runtime can auto-continue — the PROMPT did not fit, and the turn failed.
			// Folding it into `finishReason: 'length'` presented it as a successful,
			// empty turn with no error at all, so a caller parsed "" as the reply.
			// Truncation AFTER content is genuinely 'length' and must stay that way:
			// auto-continuation depends on it.
			if (result.stats.stopReason === 'contextLengthReached' && !sawContent) {
				throw new ProviderRequestError({
					kind: 'context_overflow',
					providerId: 'lmstudio',
				})
			}

			yield {
				id,
				delta: {},
				finishReason: mapStopReason(result.stats.stopReason),
				usage: mapUsage(result.stats),
			}
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'lmstudio', error: err })
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		try {
			const loaded = await this.client.llm.listLoaded()
			return loaded.map((m) => {
				const identifier = (m as { identifier?: string; path?: string }).identifier ?? ''
				return {
					id: identifier,
					name: identifier,
					contextWindow: 0,
					maxOutputTokens: 0,
					inputPrice: 0,
					outputPrice: 0,
					supportsToolUse: true,
					supportsStreaming: true,
				}
			})
		} catch {
			return []
		}
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.client.llm.listLoaded()
			return true
		} catch {
			return false
		}
	}
}
