import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import { assertThinkingUnsupported } from '@namzu/sdk'
import type { ThinkingConfig } from '@namzu/sdk'
import { toolResultToText } from '@namzu/sdk'
import {
	ProviderRequestError,
	isCallerAbortError,
	isProviderRequestError,
	providerVendorError,
} from '@namzu/sdk'
import { attributionHeaders } from '@namzu/sdk'
import OpenAI from 'openai'
import type {
	ChatCompletionContentPart,
	ChatCompletionMessageParam,
	ChatCompletionTool,
	ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions'
import type { OpenAIConfig } from './types.js'

/**
 * Full capability set — this driver maps tools (`toOpenAITools`), streams
 * natively, and maps user-message image `attachments` into `image_url`
 * content parts with base64 data URIs (`toOpenAIMessages`).
 */
export const OPENAI_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
	supportsDocuments: true,
}

type OpenAIFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call'

type NamzuFinishReason = ChatCompletionResponse['finishReason']

function mapFinishReason(reason: OpenAIFinishReason | null | undefined): NamzuFinishReason {
	switch (reason) {
		case 'length':
			return 'length'
		case 'tool_calls':
		case 'function_call':
			return 'tool_calls'
		case 'content_filter':
			return 'content_filter'
		default:
			return 'stop'
	}
}

interface RawOpenAIUsage {
	prompt_tokens?: number
	completion_tokens?: number
	total_tokens?: number
	prompt_tokens_details?: { cached_tokens?: number }
}

function parseUsage(raw?: RawOpenAIUsage | null): TokenUsage {
	if (!raw) {
		return {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
	}
	const promptTokens = raw.prompt_tokens ?? 0
	const completionTokens = raw.completion_tokens ?? 0
	return {
		promptTokens,
		completionTokens,
		totalTokens: raw.total_tokens ?? promptTokens + completionTokens,
		cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
		cacheWriteTokens: 0,
	}
}

function formatToolChoice(tc: ToolChoice | undefined): ChatCompletionToolChoiceOption | undefined {
	if (tc === undefined) return undefined
	if (tc === 'auto' || tc === 'none' || tc === 'required') return tc
	if (typeof tc === 'object' && tc.type === 'function') {
		return { type: 'function', function: { name: tc.function.name } }
	}
	return undefined
}

/**
 * Refuse an extended-thinking request this driver does not implement.
 *
 * The parameter was accepted and dropped, so a caller who had asked for
 * reasoning got an ordinary completion: no thinking, no reasoning blocks,
 * no error — and the empty reasoning array reads as "the model did not
 * reason" rather than "nobody asked it to". Turning it OFF is honoured as
 * a no-op, because that is the state the driver is already in.
 */
export function assertThinkingSupported(params: {
	thinking?: { type: 'adaptive' | 'enabled' | 'disabled' }
}): void {
	// Delegates now. The rule was decided here and then applied only here,
	// while five sibling drivers went on dropping the field silently — so it
	// moved to the SDK where a new driver inherits it instead of re-deciding
	// it. Kept as a named export because it is one, and removing it would
	// break a caller for no gain.
	assertThinkingUnsupported('OpenAIProvider', params as { thinking?: ThinkingConfig })
}

/**
 * Refuse a document whose citations this wire cannot return.
 *
 * Citations are the difference between an answer you trust and one you
 * verify, and this request format has no mechanism to carry them back.
 * Sending the document anyway would answer the question and quietly drop
 * the checkability the caller specifically asked for — the caller would
 * see prose, no error, and an empty `citations` array they might read as
 * "the model cited nothing" rather than "nobody asked".
 */
function assertCitationsSupported(
	attachment: { citations?: boolean; name?: string },
	index: number,
): void {
	if (!attachment.citations) return
	const which = attachment.name ?? `attachment ${index}`
	throw new Error(
		`This provider cannot return citations, and ${which} asked for them. Drop \`citations\` to send the document without them, or use a provider whose capabilities include citation support.`,
	)
}

export function toOpenAIMessages(
	messages: ChatCompletionParams['messages'],
): ChatCompletionMessageParam[] {
	return messages.map((msg): ChatCompletionMessageParam => {
		if (msg.role === 'system') {
			return { role: 'system', content: msg.content }
		}
		if (msg.role === 'user') {
			// User message with attachments → multimodal content parts, text
			// first. Images become an `image_url` part carrying a base64 data
			// URI; documents become a `file` part. Plain text-only user
			// messages keep the string form.
			if (msg.attachments && msg.attachments.length > 0) {
				const parts: ChatCompletionContentPart[] = []
				if (msg.content.length > 0) {
					parts.push({ type: 'text', text: msg.content })
				}
				for (const [index, att] of msg.attachments.entries()) {
					if (att.type === 'document') {
						// A document is not an image with a different media
						// type. Every attachment used to become an `image_url`,
						// so a PDF went up as `data:application/pdf;base64,...`
						// inside an image part — while the capability set
						// claimed documents were supported.
						assertCitationsSupported(att, index)
						parts.push({
							type: 'file',
							file: {
								file_data: `data:${att.mediaType};base64,${att.data}`,
								...(att.name ? { filename: att.name } : {}),
							},
						} as ChatCompletionContentPart)
						continue
					}
					parts.push({
						type: 'image_url',
						image_url: { url: `data:${att.mediaType};base64,${att.data}` },
					})
				}
				return { role: 'user', content: parts }
			}
			return { role: 'user', content: msg.content }
		}
		if (msg.role === 'tool') {
			return {
				role: 'tool',
				// Tool messages are text-only on this wire, so a content block
				// degrades to an honest placeholder rather than having its
				// base64 payload dumped as text.
				content: toolResultToText(msg.content),
				tool_call_id: msg.toolCallId,
			}
		}
		// assistant
		const assistant: ChatCompletionMessageParam = {
			role: 'assistant',
			content: msg.content,
		}
		if ('toolCalls' in msg && msg.toolCalls && msg.toolCalls.length > 0) {
			;(assistant as { tool_calls?: unknown }).tool_calls = msg.toolCalls.map((tc) => ({
				id: tc.id,
				type: 'function' as const,
				function: {
					name: tc.function.name,
					arguments: tc.function.arguments,
				},
			}))
		}
		return assistant
	})
}

/**
 * Tool schemas, with constrained generation where the caller asked for it.
 *
 * `enforceToolInputSchema` names the tools whose schema should be enforced
 * rather than suggested. Both sibling drivers consumed it; this one dropped
 * it on the floor, so a caller who had asked for a guaranteed-valid tool
 * input got a best-effort one — and found out from a repair attempt rather
 * than from an error.
 *
 * This wire is the one the flag maps onto most directly: it takes `strict`
 * on the function itself.
 */
export function toOpenAITools(params: ChatCompletionParams): ChatCompletionTool[] | undefined {
	if (!params.tools || params.tools.length === 0) return undefined
	const enforced = new Set(params.enforceToolInputSchema ?? [])
	return params.tools.map((t) => ({
		type: 'function' as const,
		function: {
			name: t.function.name,
			description: t.function.description ?? '',
			parameters: (t.function.parameters ?? {}) as Record<string, unknown>,
			...(enforced.has(t.function.name) ? { strict: true } : {}),
		},
	}))
}

export class OpenAIProvider implements LLMProvider {
	readonly id = 'openai'
	readonly name = 'OpenAI'
	readonly capabilities = OPENAI_CAPABILITIES

	private client: OpenAI
	private defaultModel?: string

	constructor(config: OpenAIConfig) {
		if (!config.apiKey) {
			throw new Error('OpenAI API key is required. Set OPENAI_API_KEY env variable.')
		}

		const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
			apiKey: config.apiKey,
		}
		if (config.baseURL) clientOptions.baseURL = config.baseURL
		if (config.organization) clientOptions.organization = config.organization
		if (config.project) clientOptions.project = config.project
		if (config.timeout !== undefined) clientOptions.timeout = config.timeout
		// Merged rather than replaced. Assigning `config.defaultHeaders`
		// straight over would drop attribution for exactly the hosts that
		// customise their transport.
		clientOptions.defaultHeaders = { ...attributionHeaders(), ...(config.defaultHeaders ?? {}) }

		this.client = new OpenAI(clientOptions)
		this.defaultModel = config.model
	}

	private resolveModel(params: ChatCompletionParams): string {
		const model = params.model || this.defaultModel
		if (!model) {
			throw new Error(
				'OpenAIProvider: model is required. Pass `model` in config or on the chat call.',
			)
		}
		return model
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const model = this.resolveModel(params)
		assertThinkingSupported(params)

		let stream: Awaited<ReturnType<typeof this.client.chat.completions.create>>
		try {
			stream = await this.client.chat.completions.create(
				{
					model,
					messages: toOpenAIMessages(params.messages),
					stream: true,
					stream_options: { include_usage: true },
					tools: toOpenAITools(params),
					tool_choice: formatToolChoice(params.toolChoice),
					parallel_tool_calls: params.parallelToolCalls,
					temperature: params.temperature,
					max_tokens: params.maxTokens,
					top_p: params.topP,
					frequency_penalty: params.frequencyPenalty,
					presence_penalty: params.presencePenalty,
					stop: params.stop,
					response_format: params.responseFormat,
				},
				// Per-request abort: a Stop tears the in-flight SSE request down.
				{ signal: params.signal },
			)
		} catch (err) {
			// The vendor SDK builds its error message FROM the response body, so a
			// credential the upstream echoed back is already inside `err.message`
			// before this code runs (proven with a planted fake token). Classify from
			// the status and drop the vendor error entirely — no re-throw, no
			// `cause`, because a `cause` is exactly what a structured logger walks.
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'openai', error: err })
		}

		try {
			for await (const chunk of stream) {
				// Stop pulling promptly on abort; `for await` calls the stream's
				// `.return()` on this throw, releasing the connection.
				params.signal?.throwIfAborted()
				try {
					const choice = chunk.choices[0]
					const delta = choice?.delta

					const toolCalls = delta?.tool_calls?.map((tc) => ({
						index: tc.index,
						id: tc.id,
						type: tc.type,
						function: tc.function
							? {
									name: tc.function.name,
									arguments: tc.function.arguments,
								}
							: undefined,
					}))

					const hasDelta =
						(delta?.content !== undefined && delta.content !== null) ||
						(toolCalls && toolCalls.length > 0)
					const finishReason = choice?.finish_reason
						? mapFinishReason(choice.finish_reason)
						: undefined
					const usage = chunk.usage ? parseUsage(chunk.usage) : undefined

					if (!hasDelta && !finishReason && !usage) continue

					yield {
						id: chunk.id,
						delta: {
							content: delta?.content ?? undefined,
							toolCalls,
						},
						finishReason,
						usage,
					}
				} catch (parseErr) {
					if (isProviderRequestError(parseErr)) throw parseErr
					throw new ProviderRequestError({
						kind: 'server',
						providerId: 'openai',
						detail: 'the provider stream returned malformed data',
					})
				}
			}
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'openai', error: err })
		}
	}

	/**
	 * Declared even though this driver's listing already fails correctly on a
	 * bad key. The check is a declared capability rather than something inferred
	 * from whether a menu happened to throw, so a driver that answers the
	 * question has to say so — otherwise it is reported unverifiable, which is
	 * the honest default and would be a regression here.
	 */
	async probeCredential(): Promise<void> {
		await this.client.models.list()
	}

	async listModels(): Promise<ModelInfo[]> {
		const page = await this.client.models.list()
		return page.data.map((m) => ({
			id: m.id,
			name: m.id,
			inputPrice: 0,
			outputPrice: 0,
			supportsToolUse: true,
			supportsStreaming: true,
		}))
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.client.models.list()
			return true
		} catch {
			return false
		}
	}
}
