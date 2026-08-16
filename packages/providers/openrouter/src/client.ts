import type {
	ChatCompletionParams,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import {
	ProviderRequestError,
	assertThinkingUnsupported,
	isCallerAbortError,
	isProviderRequestError,
	providerHttpError,
	providerVendorError,
} from '@namzu/sdk'
import { attributionHeaders } from '@namzu/sdk'
import type { OpenRouterConfig } from './types.js'

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'

interface RawUsage {
	prompt_tokens: number
	completion_tokens: number
	total_tokens: number
	prompt_tokens_details?: {
		cached_tokens?: number
	}
	cache_discount?: number
	cache_read_input_tokens?: number
	cache_creation_input_tokens?: number
}

function parseUsage(raw?: RawUsage): TokenUsage {
	if (!raw) {
		return {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
	}
	return {
		promptTokens: raw.prompt_tokens,
		completionTokens: raw.completion_tokens,
		totalTokens: raw.total_tokens,
		cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? 0,
		cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
	}
}

function formatToolChoice(tc: ToolChoice): unknown {
	if (typeof tc === 'string') return tc
	return tc
}

/**
 * What this DRIVER does, not what OpenRouter could do: tools pass
 * through to the request body, but user-message image `attachments`
 * are not mapped into content parts — `supportsVision` stays false
 * until the message translation handles them.
 */
export const OPENROUTER_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: false,
	// Images only. A document degrades to a named placeholder.
	supportsDocuments: false,
}

export class OpenRouterProvider implements LLMProvider {
	readonly id = 'openrouter'
	readonly name = 'OpenRouter'
	readonly capabilities = OPENROUTER_CAPABILITIES

	private config: OpenRouterConfig
	private baseUrl: string

	constructor(config: OpenRouterConfig) {
		if (!config.apiKey) {
			throw new Error('OpenRouter API key is required. Set OPENROUTER_API_KEY env variable.')
		}
		this.config = config
		this.baseUrl = config.baseUrl ?? OPENROUTER_BASE_URL
	}

	private getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			// First, so anything a host sets below still wins. Attribution is
			// what this kernel says about itself; a host overriding it has a
			// reason and is not to be argued with.
			...attributionHeaders(),
			Authorization: `Bearer ${this.config.apiKey}`,
			'Content-Type': 'application/json',
		}
		if (this.config.siteUrl) {
			headers['HTTP-Referer'] = this.config.siteUrl
		}
		if (this.config.siteName) {
			headers['X-Title'] = this.config.siteName
		}
		return headers
	}

	private formatMessages(messages: ChatCompletionParams['messages']): unknown[] {
		return messages.map((msg) => {
			if (msg.role === 'tool') {
				return {
					role: 'tool',
					content: msg.content,
					tool_call_id: (msg as { toolCallId?: string }).toolCallId,
				}
			}
			if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
				return {
					role: 'assistant',
					content: msg.content,
					tool_calls: msg.toolCalls.map((tc) => ({
						id: tc.id,
						type: tc.type,
						function: tc.function,
					})),
				}
			}
			return { role: msg.role, content: msg.content }
		})
	}

	private buildRequestBody(params: ChatCompletionParams, stream: boolean): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model: params.model,
			messages: this.formatMessages(params.messages),
			stream,
		}

		if (params.tools && params.tools.length > 0) {
			body.tools = params.tools
		}
		if (params.toolChoice !== undefined) {
			body.tool_choice = formatToolChoice(params.toolChoice)
		}
		if (params.parallelToolCalls !== undefined) {
			body.parallel_tool_calls = params.parallelToolCalls
		}

		if (params.temperature !== undefined) body.temperature = params.temperature
		if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens
		if (params.topP !== undefined) body.top_p = params.topP
		if (params.topK !== undefined) body.top_k = params.topK
		if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty
		if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty
		if (params.repetitionPenalty !== undefined) body.repetition_penalty = params.repetitionPenalty
		if (params.stop) body.stop = params.stop

		if (params.cacheControl) {
			body.cache_control = params.cacheControl
		}

		if (params.responseFormat) {
			body.response_format = params.responseFormat
		}

		return body
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		assertThinkingUnsupported('OpenRouterProvider', params)
		const body = this.buildRequestBody(params, true)

		const timeout = AbortSignal.timeout(this.config.timeout ?? 120_000)
		// Compose the caller abort with the request timeout so a Stop cancels the
		// response body stream. When no caller signal is present this is the exact
		// prior `AbortSignal.timeout(...)` expression (byte-identical).
		const signal = params.signal ? AbortSignal.any([timeout, params.signal]) : timeout

		let response: Response
		try {
			response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: this.getHeaders(),
				body: JSON.stringify(body),
				signal,
			})
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			throw providerVendorError({ providerId: 'openrouter', error: err })
		}

		if (!response.ok) {
			// The body is read to CLASSIFY (a 400 saying "prompt is too long" is a
			// context overflow, any other 400 is a bad request) and then dropped. It
			// used to be interpolated straight into the message, which is how a
			// credential the upstream echoed back reached every log that recorded
			// the failure — proven with a planted fake token.
			const errorBody = await response.text().catch(() => '')
			throw providerHttpError({
				providerId: 'openrouter',
				status: response.status,
				body: errorBody,
				retryAfter: response.headers.get('retry-after'),
			})
		}

		if (!response.body) {
			throw new ProviderRequestError({
				kind: 'server',
				providerId: 'openrouter',
				status: response.status,
				detail: 'the response contained no stream body',
			})
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''

		try {
			while (true) {
				params.signal?.throwIfAborted()
				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split('\n')
				buffer = lines.pop() ?? ''

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || !trimmed.startsWith('data: ')) continue
					const data = trimmed.slice(6)
					if (data === '[DONE]') return

					try {
						const parsed = JSON.parse(data) as {
							id: string
							error?: unknown
							choices: Array<{
								delta: {
									content?: string
									tool_calls?: Array<{
										index: number
										id?: string
										type?: string
										function?: { name?: string; arguments?: string }
									}>
								}
								finish_reason?: string
							}>
							usage?: RawUsage
						}

						if (parsed.error !== undefined) {
							throw providerVendorError({
								providerId: 'openrouter',
								error: new Error(data),
							})
						}

						const choice = parsed.choices[0]
						if (!choice) continue

						yield {
							id: parsed.id,
							delta: {
								content: choice.delta.content,
								toolCalls: choice.delta.tool_calls?.map((tc) => ({
									index: tc.index,
									id: tc.id,
									type: tc.type as 'function' | undefined,
									function: tc.function,
								})),
							},
							finishReason: choice.finish_reason as StreamChunk['finishReason'],
							usage: parsed.usage ? parseUsage(parsed.usage) : undefined,
						}
					} catch (parseErr) {
						if (isProviderRequestError(parseErr)) throw parseErr
						// JSON SyntaxError messages include a source snippet, and
						// mapping failures may include vendor values. Drop both.
						throw new ProviderRequestError({
							kind: 'server',
							providerId: 'openrouter',
							detail: 'the provider stream returned malformed data',
						})
					}
				}
			}
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'openrouter', error: err })
		} finally {
			reader.releaseLock()
		}
	}

	/**
	 * Ask about the KEY, not about the catalogue.
	 *
	 * `listModels` here is already honest — it has no fallback and returns
	 * exactly what the server sent. It is still useless as a credential check,
	 * because `/models` does not authenticate: any string whatsoever, including
	 * a typo or a revoked key, came back with the full catalogue and was
	 * reported as verified. Nothing was wrong with the menu; the menu was simply
	 * never evidence about the key.
	 *
	 * `/key` is the endpoint that answers the question actually being asked. It
	 * requires the credential and returns its metadata, so a 401 here means the
	 * key is genuinely refused.
	 */
	async probeCredential(): Promise<void> {
		const response = await fetch(`${this.baseUrl}/key`, { headers: this.getHeaders() })
		if (!response.ok) {
			const err = new Error(`Credential check failed: ${response.status}`) as Error & {
				status?: number
			}
			err.status = response.status
			throw err
		}
	}

	/**
	 * The vendor's own `context_length` for this model.
	 *
	 * This driver already parsed the number and threw it away: `listModels`
	 * maps it into `contextWindow` and nothing downstream ever asked. The
	 * kernel meanwhile fell back to a hand-maintained prefix table whose own
	 * header records what that costs — every Claude entry carried 200k
	 * including the 1M-window models, so those runs compacted at roughly 14%
	 * full. OpenRouter fronts hundreds of models from a dozen vendors, so it
	 * is the driver where a static table drifts fastest.
	 *
	 * `undefined` for a model the listing does not contain, rather than a
	 * guess: "I asked and it is not there" leaves the table exactly as
	 * authoritative as it was, while a substituted number would present a
	 * guess as a vendor answer.
	 *
	 * Cached for the process, because a listing of several hundred models is
	 * a real payload and a model's window does not change under a running
	 * run. A failure is NOT cached — the next run asks again rather than
	 * inheriting one bad minute forever.
	 */
	async resolveContextWindow(model: string, signal?: AbortSignal): Promise<number | undefined> {
		const pending =
			this.contextWindows ??
			(async () => {
				const models = await this.listModels()
				return new Map<string, number>(
					models
						.filter(
							(m): m is typeof m & { contextWindow: number } => typeof m.contextWindow === 'number',
						)
						.map((m) => [m.id, m.contextWindow]),
				)
			})().catch((err: unknown) => {
				// Not cached. A listing endpoint that was down for a minute must
				// not leave every later run answering from that minute.
				this.contextWindows = undefined
				throw err
			})
		this.contextWindows = pending

		const windows = await pending
		if (signal?.aborted) return undefined
		const reported = windows.get(model)
		return typeof reported === 'number' && reported > 0 ? reported : undefined
	}

	/** Resolved once per process; see the note on `resolveContextWindow`. */
	private contextWindows?: Promise<Map<string, number>>

	async listModels(): Promise<ModelInfo[]> {
		const response = await fetch(`${this.baseUrl}/models`, {
			headers: this.getHeaders(),
		})

		if (!response.ok) {
			throw new Error(`Failed to list models: ${response.status}`)
		}

		const data = (await response.json()) as {
			data: Array<{
				id: string
				name: string
				context_length: number
				top_provider?: { max_completion_tokens?: number }
				pricing?: { prompt: string; completion: string }
			}>
		}

		return data.data.map((m) => ({
			id: m.id,
			name: m.name,
			contextWindow: m.context_length,
			maxOutputTokens: m.top_provider?.max_completion_tokens ?? 4096,
			inputPrice: Number.parseFloat(m.pricing?.prompt ?? '0') * 1_000_000,
			outputPrice: Number.parseFloat(m.pricing?.completion ?? '0') * 1_000_000,
			supportsToolUse: true,
			supportsStreaming: true,
		}))
	}

	async healthCheck(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/models`, {
				headers: this.getHeaders(),
				signal: AbortSignal.timeout(5000),
			})
			return response.ok
		} catch {
			return false
		}
	}
}
