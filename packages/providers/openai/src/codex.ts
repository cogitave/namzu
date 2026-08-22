import type {
	ChatCompletionParams,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	ProviderRoute,
	ReasoningEffort,
	StreamChunk,
	TokenUsage,
} from '@namzu/sdk'
import {
	ProviderRequestError,
	attributionHeaders,
	isCallerAbortError,
	isProviderRequestError,
	providerVendorError,
	toolResultToText,
} from '@namzu/sdk'
import OpenAI from 'openai'
import type {
	ResponseCreateParamsStreaming,
	ResponseInputItem,
	ResponseOutputItem,
	ResponseStreamEvent,
	Tool,
} from 'openai/resources/responses/responses'

import { openAIReasoningEffortLevels } from './client.js'
import type { CodexConfig } from './types.js'

export const CODEX_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: false,
	supportsDocuments: false,
}

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

interface CodexReplayState {
	readonly kind: 'namzu.codex.responses'
	readonly version: 1
	readonly route: ProviderRoute
	readonly content: string | null
	readonly toolCalls: readonly {
		readonly id: string
		readonly name: string
		readonly arguments: string
	}[]
	readonly items: readonly ResponseOutputItem[]
}

function sameRoute(left: ProviderRoute, right: ProviderRoute): boolean {
	return (
		left.providerId === right.providerId &&
		left.model === right.model &&
		left.chainIndex === right.chainIndex
	)
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function isRoute(value: unknown): value is ProviderRoute {
	const route = record(value)
	return (
		typeof route?.providerId === 'string' &&
		typeof route.model === 'string' &&
		Number.isInteger(route.chainIndex) &&
		(route.chainIndex as number) >= 0
	)
}

function durableToolCalls(
	message: Extract<ChatCompletionParams['messages'][number], { role: 'assistant' }>,
): CodexReplayState['toolCalls'] {
	return (message.toolCalls ?? []).map((call) => ({
		id: call.id,
		name: call.function.name,
		arguments: call.function.arguments,
	}))
}

function isCodexReplayState(value: unknown): value is CodexReplayState {
	const state = record(value)
	if (
		state?.kind !== 'namzu.codex.responses' ||
		state.version !== 1 ||
		!isRoute(state.route) ||
		(state.content !== null && typeof state.content !== 'string') ||
		!Array.isArray(state.toolCalls) ||
		!Array.isArray(state.items)
	) {
		return false
	}
	return state.toolCalls.every((item) => {
		const call = record(item)
		return (
			typeof call?.id === 'string' &&
			typeof call.name === 'string' &&
			typeof call.arguments === 'string'
		)
	})
}

function replayItems(
	message: Extract<ChatCompletionParams['messages'][number], { role: 'assistant' }>,
	targetRoute: ProviderRoute,
): readonly ResponseOutputItem[] | null {
	const source = message.source
	if (!source || source.type !== 'model' || !sameRoute(source, targetRoute)) return null
	const state = source.replayState
	if (!isCodexReplayState(state) || !sameRoute(state.route, source)) return null
	if (state.content !== message.content) return null
	if (JSON.stringify(state.toolCalls) !== JSON.stringify(durableToolCalls(message))) return null
	return state.items
}

export function toCodexInput(
	messages: ChatCompletionParams['messages'],
	targetRoute: ProviderRoute,
): ResponseInputItem[] {
	const input: ResponseInputItem[] = []
	for (const message of messages) {
		if (message.role === 'system') continue
		if (message.role === 'user') {
			if (message.attachments && message.attachments.length > 0) {
				throw new Error(
					'CodexProvider: this transport does not yet admit image or document attachments. Remove the attachment or select a provider whose declared capabilities include it.',
				)
			}
			input.push({ type: 'message', role: 'user', content: message.content })
			continue
		}
		if (message.role === 'tool') {
			input.push({
				type: 'function_call_output',
				call_id: message.toolCallId,
				output: toolResultToText(message.content),
			})
			continue
		}
		const replayed = replayItems(message, targetRoute)
		if (replayed) {
			input.push(...(replayed as ResponseInputItem[]))
			continue
		}
		if (message.content) {
			input.push({
				type: 'message',
				role: 'assistant',
				content: message.content,
			})
		}
		for (const call of message.toolCalls ?? []) {
			input.push({
				type: 'function_call',
				call_id: call.id,
				name: call.function.name,
				arguments: call.function.arguments,
			})
		}
	}
	return input
}

export function toCodexTools(params: ChatCompletionParams): Tool[] | undefined {
	if (!params.tools || params.tools.length === 0) return undefined
	return params.tools.map((tool) => ({
		type: 'function',
		name: tool.function.name,
		description: tool.function.description ?? '',
		parameters: tool.function.parameters ?? {},
		// The ChatGPT Codex backend validates `strict: true` against a narrower
		// Responses schema than the Chat Completions endpoint. In particular,
		// every composition branch needs an explicit type and every object
		// property must also be required. Namzu model schemas deliberately keep
		// conditional edit shapes optional and validate the selected shape at
		// execution, so claiming strictness rejects the whole request before the
		// model can answer. The Codex client uses the same boundary for its own
		// tools: Responses function tools are sent with `strict: false` and tool
		// inputs are validated by the runtime. `enforceToolInputSchema` remains a
		// provider hint; this transport cannot truthfully consume it for Namzu's
		// general tool-schema contract.
		strict: false,
	}))
}

function responseUsage(usage: {
	input_tokens?: number
	output_tokens?: number
	total_tokens?: number
	input_tokens_details?: { cached_tokens?: number }
}): TokenUsage {
	const promptTokens = usage.input_tokens ?? 0
	const completionTokens = usage.output_tokens ?? 0
	return {
		promptTokens,
		completionTokens,
		totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
		cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
		cacheWriteTokens: 0,
	}
}

function buildRequest(
	params: ChatCompletionParams,
	model: string,
	targetRoute: ProviderRoute,
): ResponseCreateParamsStreaming {
	const supportedEffort = openAIReasoningEffortLevels(model)
	if (
		params.effort !== undefined &&
		supportedEffort !== undefined &&
		!supportedEffort.includes(params.effort)
	) {
		throw new Error(
			`CodexProvider: effort "${params.effort}" is not supported by model "${model}". Supported levels: ${supportedEffort.join(', ')}. Choose one of those levels or omit \`effort\`.`,
		)
	}
	if (params.thinking?.type === 'enabled') {
		throw new Error(
			'CodexProvider: manual thinking budgets are not a Responses API capability. Use adaptive thinking or omit `thinking`.',
		)
	}
	if (params.thinking?.type === 'disabled' && params.effort !== 'none') {
		throw new Error(
			'CodexProvider: disabling reasoning requires `effort: "none"`; omitting that level would not prove reasoning was disabled.',
		)
	}
	const instructions = params.messages
		.filter((message) => message.role === 'system')
		.map((message) => message.content)
		.join('\n\n')
	const request = {
		model,
		stream: true,
		store: false,
		instructions: instructions || undefined,
		input: toCodexInput(params.messages, targetRoute),
		// The Codex subscription request schema deliberately has no
		// `max_output_tokens` member. `ChatCompletionParams.maxTokens` is a public
		// API control, but projecting it onto this route makes the whole request
		// invalid; the backend owns the output budget here.
		// The subscription Responses backend expects these three fields even for a
		// turn that exposes no tools.  The ordinary public Responses endpoint admits
		// their omission, which is why the generated client types all make them
		// optional; the Codex wire does not have the same defaulting contract.
		tools: toCodexTools(params) ?? [],
		tool_choice: (params.toolChoice ?? 'auto') as ResponseCreateParamsStreaming['tool_choice'],
		parallel_tool_calls: params.parallelToolCalls ?? true,
		include: ['reasoning.encrypted_content'],
		...(params.effort !== undefined
			? { reasoning: { effort: params.effort, summary: 'auto' } }
			: params.thinking?.type === 'adaptive'
				? { reasoning: { summary: 'auto' } }
				: {}),
	}
	// The installed client declaration predates the current GPT-5.6 `max`
	// vocabulary. The model-specific admission check above is the runtime
	// boundary; this cast only bridges that vendor declaration lag.
	return request as ResponseCreateParamsStreaming
}

export class CodexProvider implements LLMProvider {
	readonly id = 'codex'
	readonly name = 'OpenAI Codex'
	readonly capabilities = CODEX_CAPABILITIES

	private client: OpenAI
	private defaultModel?: string

	constructor(config: CodexConfig) {
		if (!config.accessToken) throw new Error('Codex access token is required.')
		if (!config.accountId) throw new Error('Codex ChatGPT account id is required.')
		this.client = new OpenAI({
			apiKey: config.accessToken,
			baseURL: config.baseURL ?? DEFAULT_CODEX_BASE_URL,
			timeout: config.timeout,
			defaultHeaders: {
				...attributionHeaders(),
				'ChatGPT-Account-Id': config.accountId,
				originator: 'Codex Namzu',
				'User-Agent': 'Codex Namzu/1.0',
				...(config.defaultHeaders ?? {}),
			},
		})
		this.defaultModel = config.model
	}

	private resolveModel(params: ChatCompletionParams): string {
		const model = params.model || this.defaultModel
		if (!model) throw new Error('CodexProvider: model is required.')
		return model
	}

	reasoningEffortLevelsFor(model: string): readonly ReasoningEffort[] | undefined {
		return openAIReasoningEffortLevels(model)
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const model = this.resolveModel(params)
		const targetRoute = params.providerRoute ?? {
			providerId: this.id,
			model,
			chainIndex: 0,
		}
		const request = buildRequest(params, model, targetRoute)
		let stream: AsyncIterable<ResponseStreamEvent>
		try {
			stream = (await this.client.responses.create(request, {
				signal: params.signal,
			})) as AsyncIterable<ResponseStreamEvent>
		} catch (error) {
			if (isCallerAbortError(error, params.signal)) throw params.signal?.reason ?? error
			if (isProviderRequestError(error)) throw error
			throw providerVendorError({ providerId: this.id, error })
		}

		const callIndex = new Map<string, number>()
		let nextCallIndex = 0
		let responseId = 'codex-response'
		try {
			for await (const event of stream) {
				params.signal?.throwIfAborted()
				switch (event.type) {
					case 'response.created':
						responseId = event.response.id
						break
					case 'response.output_text.delta':
						yield { id: responseId, delta: { content: event.delta } }
						break
					case 'response.reasoning_summary_text.delta':
						yield {
							id: responseId,
							delta: {
								reasoning: {
									index: event.output_index,
									type: 'thinking',
									text: event.delta,
								},
							},
						}
						break
					case 'response.reasoning_summary_text.done':
						yield {
							id: responseId,
							delta: {
								reasoning: {
									index: event.output_index,
									type: 'thinking',
									done: true,
								},
							},
						}
						break
					case 'response.output_item.added':
						if (event.item.type === 'function_call') {
							const index = nextCallIndex++
							callIndex.set(event.item.id ?? event.item.call_id, index)
							callIndex.set(event.item.call_id, index)
							yield {
								id: responseId,
								delta: {
									toolCalls: [
										{
											index,
											id: event.item.call_id,
											type: 'function',
											function: {
												name: event.item.name,
												arguments: event.item.arguments,
											},
										},
									],
								},
							}
						}
						break
					case 'response.function_call_arguments.delta': {
						const index = callIndex.get(event.item_id) ?? event.output_index
						yield {
							id: responseId,
							delta: {
								toolCalls: [{ index, function: { arguments: event.delta } }],
							},
						}
						break
					}
					case 'response.output_item.done':
						if (event.item.type === 'function_call') {
							yield {
								id: responseId,
								delta: {
									toolCallEnd: {
										index: callIndex.get(event.item.id ?? event.item.call_id) ?? event.output_index,
										id: event.item.call_id,
									},
								},
							}
						}
						break
					case 'response.completed': {
						const calls = event.response.output
							.filter((item) => item.type === 'function_call')
							.map((item) => ({
								id: item.call_id,
								name: item.name,
								arguments: item.arguments,
							}))
						const content = event.response.output
							.filter((item) => item.type === 'message')
							.flatMap((item) => item.content)
							.filter((item) => item.type === 'output_text')
							.map((item) => item.text)
							.join('')
						const replayState: CodexReplayState = {
							kind: 'namzu.codex.responses',
							version: 1,
							route: targetRoute,
							content: content || null,
							toolCalls: calls,
							items: event.response.output,
						}
						yield {
							id: event.response.id,
							delta: {},
							finishReason: calls.length > 0 ? 'tool_calls' : 'stop',
							usage: responseUsage(event.response.usage ?? {}),
							replayState,
						}
						break
					}
					case 'error':
					case 'response.failed':
						throw new ProviderRequestError({
							kind: 'server',
							providerId: this.id,
							detail: 'the Codex Responses stream failed',
						})
				}
			}
		} catch (error) {
			if (isCallerAbortError(error, params.signal)) throw params.signal?.reason ?? error
			if (isProviderRequestError(error)) throw error
			throw providerVendorError({ providerId: this.id, error })
		}
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		signal?.throwIfAborted()
		const response = (await this.client.get('/models?client_version=1.0.0', {
			signal,
		})) as { models?: unknown }
		signal?.throwIfAborted()
		if (!Array.isArray(response.models)) return []
		return response.models.flatMap((value): ModelInfo[] => {
			const item = record(value)
			if (typeof item?.slug !== 'string' || item.slug.length === 0) return []
			if (item.visibility === 'hide' || item.visibility === 'hidden') return []
			return [
				{
					id: item.slug,
					name: typeof item.display_name === 'string' ? item.display_name : item.slug,
					inputPrice: 0,
					outputPrice: 0,
					supportsToolUse: true,
					supportsStreaming: true,
				},
			]
		})
	}

	async probeCredential(signal?: AbortSignal): Promise<void> {
		await this.listModels(signal)
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.probeCredential()
			return true
		} catch {
			return false
		}
	}
}
