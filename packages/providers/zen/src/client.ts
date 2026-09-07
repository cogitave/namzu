import { randomUUID } from 'node:crypto'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
	APICallError,
	type LanguageModelV3,
	type LanguageModelV3Content,
	type LanguageModelV3StreamPart,
	type LanguageModelV3Usage,
	type SharedV3ProviderMetadata,
} from '@ai-sdk/provider'
import {
	type ChatCompletionParams,
	type LLMProvider,
	type ModelInfo,
	type ProviderCapabilities,
	ProviderRequestError,
	type ReasoningEffort,
	type StreamChunk,
	type ThinkingConfig,
	type TokenUsage,
	attributionHeaders,
	isProviderRequestError,
	providerHttpError,
	providerVendorError,
} from '@namzu/sdk'
import { type ZenService, findZenModel } from './models.js'
import { createCallOptions } from './options.js'
import { createReplayState, toReasoningBlocks } from './prompt.js'
import type { ZenConfig } from './types.js'

export const ZEN_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
	supportsDocuments: true,
	supportsToolResultImages: true,
	supportsToolResultDocuments: true,
}

export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
export const ZEN_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'

/** A provider instance belongs to one conversation; it never owns an agent loop. */
export class ZenProvider implements LLMProvider {
	readonly id: 'zen' | 'zen-go'
	readonly name: string
	readonly capabilities = ZEN_CAPABILITIES
	readonly sessionId: string
	private readonly baseURL: string
	private readonly timeout: number
	private readonly requestFetch: typeof fetch

	constructor(
		private readonly config: ZenConfig,
		readonly service: ZenService = 'zen',
	) {
		if (service !== 'zen' && service !== 'go') throw new Error('Unknown service.')
		if (config.protocol && !['chat', 'responses', 'messages', 'google'].includes(config.protocol))
			throw new Error('Unknown model protocol.')
		this.id = service === 'go' ? 'zen-go' : 'zen'
		this.name = service === 'go' ? 'Zen Go' : 'Zen'
		if (!config.apiKey.trim()) throw new Error(`${this.name} requires an API key.`)
		this.sessionId = config.sessionId ?? randomUUID()
		if (
			!this.sessionId.trim() ||
			/[\r\n]/.test(this.sessionId) ||
			Buffer.byteLength(this.sessionId) > 512
		)
			throw new Error('A nonempty, single-line conversation sessionId is required.')
		this.baseURL = (config.baseURL ?? (service === 'go' ? ZEN_GO_BASE_URL : ZEN_BASE_URL)).replace(
			/\/+$/,
			'',
		)
		const url = new URL(this.baseURL)
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new Error(
				'baseURL must be an HTTP(S) service URL without credentials, query or fragment.',
			)
		this.timeout = config.timeout ?? 120_000
		if (!Number.isSafeInteger(this.timeout) || this.timeout <= 0)
			throw new Error('timeout must be a positive integer in milliseconds.')
		this.requestFetch = (input, init) => {
			const headers = new Headers(init?.headers)
			for (const [key, value] of Object.entries(attributionHeaders())) headers.set(key, value)
			headers.set('x-opencode-session', this.sessionId)
			return fetch(input, { ...init, headers, redirect: 'error' })
		}
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const model = params.model || this.config.model || 'glm-5.3-flash'
		const info = findZenModel(this.service, model)
		const protocol = this.config.protocol ?? info?.protocol
		if (!protocol)
			throw new ProviderRequestError({
				providerId: this.id,
				kind: 'bad_request',
				detail:
					'This model has no known wire format. Update the provider or configure protocol explicitly.',
			})
		const route = params.providerRoute ?? { providerId: this.id, model, chainIndex: 0 }
		const controller = new AbortController()
		const signal = AbortSignal.any([
			controller.signal,
			AbortSignal.timeout(this.timeout),
			...(params.signal ? [params.signal] : []),
		])
		let reader: ReadableStreamDefaultReader<LanguageModelV3StreamPart> | undefined
		try {
			signal.throwIfAborted()
			let options: ReturnType<typeof createCallOptions>
			try {
				options = createCallOptions({ ...params, model }, route, this.service, protocol)
			} catch (error) {
				if (isProviderRequestError(error)) throw error
				throw new ProviderRequestError({
					providerId: this.id,
					kind: 'bad_request',
					detail: 'The message history contains content this model protocol cannot encode.',
				})
			}
			options.abortSignal = signal
			const settings = {
				apiKey: this.config.apiKey,
				baseURL: this.baseURL,
				fetch: this.requestFetch,
			}
			let native: LanguageModelV3
			switch (protocol) {
				case 'chat':
					native = createOpenAICompatible({
						...settings,
						name: 'opencode',
						includeUsage: true,
						supportsStructuredOutputs: true,
					})(model)
					break
				case 'responses':
					native = createOpenAI(settings).responses(model)
					break
				case 'messages':
					native = createAnthropic(settings)(model)
					break
				case 'google':
					native = createGoogleGenerativeAI(settings)(model)
					break
			}
			const result = await native.doStream(options)
			reader = result.stream.getReader()
			let id = randomUUID() as string
			const content: LanguageModelV3Content[] = []
			const texts = new Map<string, Extract<LanguageModelV3Content, { type: 'text' }>>()
			const thoughts = new Map<
				string,
				{ index: number; value: Extract<LanguageModelV3Content, { type: 'reasoning' }> }
			>()
			const tools = new Map<
				string,
				{
					index: number
					input: string
					ended: boolean
					value: Extract<LanguageModelV3Content, { type: 'tool-call' }>
				}
			>()
			let finish: Extract<LanguageModelV3StreamPart, { type: 'finish' }> | undefined
			while (true) {
				const next = await reader.read()
				if (next.done) break
				const part = next.value
				signal.throwIfAborted()
				switch (part.type) {
					case 'stream-start': {
						const unsupported = part.warnings.filter((warning) => warning.type === 'unsupported')
						if (unsupported.length)
							throw new ProviderRequestError({
								providerId: this.id,
								kind: 'bad_request',
								detail:
									'The selected model protocol cannot honor one or more requested settings or content parts.',
							})
						break
					}
					case 'response-metadata':
						if (part.id) id = part.id
						break
					case 'text-start': {
						const value = {
							type: 'text' as const,
							text: '',
							providerMetadata: part.providerMetadata,
						}
						texts.set(part.id, value)
						content.push(value)
						break
					}
					case 'text-delta': {
						const value = texts.get(part.id)
						if (!value) throw new Error('Text delta has no open block.')
						value.text += part.delta
						value.providerMetadata = mergeMetadata(value.providerMetadata, part.providerMetadata)
						yield { id, delta: { content: part.delta } }
						break
					}
					case 'text-end': {
						const value = texts.get(part.id)
						if (value)
							value.providerMetadata = mergeMetadata(value.providerMetadata, part.providerMetadata)
						break
					}
					case 'reasoning-start': {
						const value = {
							type: 'reasoning' as const,
							text: '',
							providerMetadata: part.providerMetadata,
						}
						const index = thoughts.size
						thoughts.set(part.id, { index, value })
						content.push(value)
						yield { id, delta: { reasoning: { index, type: 'thinking', text: '' } } }
						break
					}
					case 'reasoning-delta':
					case 'reasoning-end': {
						const thought = thoughts.get(part.id)
						if (!thought) throw new Error('Reasoning delta has no open block.')
						thought.value.providerMetadata = mergeMetadata(
							thought.value.providerMetadata,
							part.providerMetadata,
						)
						if (part.type === 'reasoning-delta') thought.value.text += part.delta
						yield {
							id,
							delta: {
								reasoning: {
									index: thought.index,
									...(part.type === 'reasoning-delta'
										? { text: part.delta }
										: {
												...toReasoningBlocks([thought.value])[0],
												text: undefined,
												done: true,
											}),
								},
							},
						}
						break
					}
					case 'tool-input-start': {
						if (part.providerExecuted)
							throw new Error('Provider-executed tools are not configured.')
						const index = tools.size
						const value = {
							type: 'tool-call' as const,
							toolCallId: part.id,
							toolName: part.toolName,
							input: '',
							providerMetadata: part.providerMetadata,
						}
						tools.set(part.id, { index, input: '', ended: false, value })
						content.push(value)
						yield {
							id,
							delta: {
								toolCalls: [
									{
										index,
										id: part.id,
										type: 'function',
										function: { name: part.toolName, arguments: '' },
									},
								],
							},
						}
						break
					}
					case 'tool-input-delta': {
						const tool = tools.get(part.id)
						if (!tool) throw new Error('Tool delta has no open call.')
						tool.input += part.delta
						tool.value.input = tool.input
						tool.value.providerMetadata = mergeMetadata(
							tool.value.providerMetadata,
							part.providerMetadata,
						)
						yield {
							id,
							delta: { toolCalls: [{ index: tool.index, function: { arguments: part.delta } }] },
						}
						break
					}
					case 'tool-input-end': {
						const tool = tools.get(part.id)
						if (tool)
							tool.value.providerMetadata = mergeMetadata(
								tool.value.providerMetadata,
								part.providerMetadata,
							)
						// The final tool-call includes signatures and the authoritative arguments.
						break
					}
					case 'tool-call': {
						if (part.providerExecuted)
							throw new Error('Provider-executed tools are not configured.')
						let tool = tools.get(part.toolCallId)
						if (!tool) {
							tool = { index: tools.size, input: '', ended: false, value: { ...part } }
							tools.set(part.toolCallId, tool)
							content.push(tool.value)
							yield {
								id,
								delta: {
									toolCalls: [
										{
											index: tool.index,
											id: part.toolCallId,
											type: 'function',
											function: { name: part.toolName, arguments: '' },
										},
									],
								},
							}
						}
						if (tool.ended) throw new Error('Duplicate completed tool call.')
						if (!part.input.startsWith(tool.input))
							throw new Error('Final tool arguments do not match the stream.')
						const suffix = part.input.slice(tool.input.length)
						if (suffix)
							yield {
								id,
								delta: { toolCalls: [{ index: tool.index, function: { arguments: suffix } }] },
							}
						tool.value.input = part.input
						tool.value.providerMetadata = mergeMetadata(
							tool.value.providerMetadata,
							part.providerMetadata,
						)
						tool.ended = true
						yield { id, delta: { toolCallEnd: { index: tool.index, id: part.toolCallId } } }
						break
					}
					case 'finish':
						finish = part
						break
					case 'error':
						throw part.error
					case 'raw':
					case 'source':
						break
					default:
						throw new Error('Unsupported model output part.')
				}
			}
			if (!finish) throw new Error('The model stream ended before its final outcome.')
			if (finish.finishReason.unified === 'error' || finish.finishReason.unified === 'other')
				throw new Error('The model did not report a successful finish reason.')
			const finishReason =
				finish.finishReason.unified === 'length'
					? 'length'
					: finish.finishReason.unified === 'content-filter'
						? 'content_filter'
						: tools.size > 0
							? 'tool_calls'
							: 'stop'
			yield {
				id,
				delta: {},
				finishReason,
				usage: mapUsage(finish.usage),
				replayState: createReplayState(
					{ ...params, model },
					route,
					this.service,
					protocol,
					content,
				),
			}
		} catch (error) {
			if (params.signal?.aborted) throw params.signal.reason
			if (isProviderRequestError(error)) throw error
			throw this.failure(error)
		} finally {
			controller.abort()
			if (reader) {
				await reader.cancel().catch(() => {})
				reader.releaseLock()
			}
		}
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		try {
			const response = await this.requestFetch(`${this.baseURL}/models`, {
				headers: { Authorization: `Bearer ${this.config.apiKey}` },
				signal: AbortSignal.any([AbortSignal.timeout(this.timeout), ...(signal ? [signal] : [])]),
			})
			if (!response.ok) {
				await response.body?.cancel()
				throw providerHttpError({
					providerId: this.id,
					status: response.status,
					body: undefined,
					retryAfter: response.headers.get('retry-after'),
				})
			}
			const body: unknown = await readCatalogue(response)
			if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data))
				throw new Error('The model catalogue returned an invalid response.')
			const result: ModelInfo[] = []
			const seen = new Set<string>()
			for (const item of body.data) {
				if (!item || typeof item !== 'object' || typeof item.id !== 'string' || seen.has(item.id))
					continue
				seen.add(item.id)
				const model = findZenModel(this.service, item.id)
				if (model) result.push({ ...model })
			}
			return result
		} catch (error) {
			if (signal?.aborted) throw signal.reason
			if (isProviderRequestError(error)) throw error
			throw this.failure(error)
		}
	}

	reasoningEffortLevelsFor(
		model: string,
		_thinking?: ThinkingConfig,
	): readonly ReasoningEffort[] | undefined {
		return findZenModel(this.service, model)?.effortLevels
	}

	async resolveContextWindow(model: string, signal?: AbortSignal): Promise<number | undefined> {
		signal?.throwIfAborted()
		return findZenModel(this.service, model)?.contextWindow
	}

	private failure(error: unknown): ProviderRequestError {
		const scrub = (text: string) => text.split(this.config.apiKey).join('[REDACTED:api-key]')
		if (APICallError.isInstance(error))
			return providerHttpError({
				providerId: this.id,
				status: error.statusCode ?? 502,
				body: scrub(error.responseBody ?? error.message),
				retryAfter: error.responseHeaders?.['retry-after'],
			})
		// Native streaming adapters can emit plain error envelopes after HTTP 200.
		// Keep only classification fields; never attach the original error/cause.
		const envelope = safeErrorEnvelope(error)
		const body = scrub(JSON.stringify(envelope))
		if (envelope.status !== undefined)
			return providerHttpError({ providerId: this.id, status: envelope.status, body })
		return providerVendorError({
			providerId: this.id,
			error: Object.assign(new Error(body), {
				...(envelope.code !== undefined ? { code: scrub(envelope.code) } : {}),
			}),
		})
	}
}

export class ZenGoProvider extends ZenProvider {
	constructor(config: ZenConfig) {
		super(config, 'go')
	}
}

function safeErrorEnvelope(error: unknown): {
	type?: string
	code?: string
	message: string
	status?: number
} {
	const own = (value: unknown, key: string): unknown =>
		typeof value === 'object' && value !== null
			? Object.getOwnPropertyDescriptor(value, key)?.value
			: undefined
	const nested = own(error, 'error')
	const source = typeof nested === 'object' && nested !== null ? nested : error
	const type = own(source, 'type')
	const code = own(source, 'code')
	const message = typeof source === 'string' ? source : own(source, 'message')
	const status = own(source, 'status') ?? own(source, 'statusCode') ?? own(error, 'status')
	return {
		...(typeof type === 'string' && type.length <= 80 ? { type } : {}),
		...(typeof code === 'string' && code.length <= 80 ? { code } : {}),
		message: typeof message === 'string' ? message.slice(0, 8192) : 'The model stream failed.',
		...(typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
			? { status }
			: {}),
	}
}

function mergeMetadata(
	left?: SharedV3ProviderMetadata,
	right?: SharedV3ProviderMetadata,
): SharedV3ProviderMetadata | undefined {
	if (!right) return left
	const result = { ...left }
	for (const [key, value] of Object.entries(right)) result[key] = { ...result[key], ...value }
	return result
}

function mapUsage(usage: LanguageModelV3Usage): TokenUsage {
	const promptTokens = usage.inputTokens.total ?? 0
	const completionTokens = usage.outputTokens.total ?? 0
	return {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		cachedTokens: usage.inputTokens.cacheRead ?? 0,
		cacheWriteTokens: usage.inputTokens.cacheWrite ?? 0,
		...(usage.outputTokens.reasoning !== undefined
			? { reasoningTokens: usage.outputTokens.reasoning }
			: {}),
	}
}

async function readCatalogue(response: Response): Promise<unknown> {
	const reader = response.body?.getReader()
	if (!reader) throw new Error('Empty model catalogue.')
	const chunks: Uint8Array[] = []
	let bytes = 0
	try {
		while (true) {
			const next = await reader.read()
			if (next.done) break
			bytes += next.value.byteLength
			if (bytes > 1_048_576) throw new Error('The model catalogue exceeds 1 MiB.')
			chunks.push(next.value)
		}
		return JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
		)
	} finally {
		await reader.cancel().catch(() => {})
		reader.releaseLock()
	}
}
