import {
	BedrockRuntimeClient,
	ConverseCommand,
	ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime'
import type {
	Message as BedrockMessage,
	ContentBlock,
	ConversationRole,
	ConverseStreamOutput,
	ImageFormat,
	SystemContentBlock,
	Tool,
	ToolConfiguration,
	ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	ProviderErrorCode,
	StreamChunk,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import { ProviderError, classifyProviderError, isAbortError, toolResultToText } from '@namzu/sdk'
import type { BedrockConfig } from './types.js'

/**
 * A cache breakpoint on this wire is a content BLOCK, not an annotation on
 * a neighbouring block: everything before it in render order is cached,
 * the block itself marks the boundary.
 *
 * Render order is tools → system → messages, so a breakpoint late in the
 * request covers every section ahead of it. Placing one at the tail of
 * each section means the tool schemas survive as a cached prefix even
 * when the conversation below them changes on every turn — which is the
 * whole point, since the tool block is both the largest static segment
 * and the first thing an invalidated prefix would throw away.
 */
const CACHE_POINT = { cachePoint: { type: 'default' as const } }

/**
 * System messages become one block each so the runtime's `cacheHint`
 * boundaries survive into the request: the prompt builder tags the static
 * segment `'cache'` and the per-run dynamic segment `'ephemeral'`. The
 * breakpoint goes after the LAST `'cache'`-tagged block, so the static
 * prefix is cached and the dynamic tail after it is not — putting it at
 * the very end instead would cache text that changes every run, which
 * invalidates the entry on every turn and costs a cache WRITE each time
 * for nothing.
 */
function extractSystemBlocks(
	messages: ChatCompletionParams['messages'],
	cachingEnabled: boolean,
): SystemContentBlock[] {
	const blocks: SystemContentBlock[] = []
	let lastCacheTagged = -1
	for (const m of messages) {
		if (m.role !== 'system') continue
		const text = typeof m.content === 'string' ? m.content : ''
		if (text.length === 0) continue
		blocks.push({ text })
		if (m.cacheHint === 'cache') lastCacheTagged = blocks.length - 1
	}
	if (cachingEnabled && lastCacheTagged >= 0) {
		blocks.splice(lastCacheTagged + 1, 0, CACHE_POINT)
	}
	return blocks
}

/**
 * Final breakpoint: after the last content block of the last message.
 * Caches the whole conversation prefix, so the next iteration — which
 * only appends — reads all of the prior history at cache rates.
 *
 * A breakpoint may not follow an empty message, so trailing empties are
 * skipped rather than tagged.
 */
function applyMessageCacheBreakpoint(messages: BedrockMessage[]): void {
	// Two anchors. One at the tail writes a new entry every turn and reads
	// none of them, because by the next request the tail has moved and the
	// marker no longer sits where the previous entry ends. The second goes
	// one turn back — where the PREVIOUS request put its tail marker — so
	// the next request finds a prefix that is already cached.
	//
	// The gap matters most where the history grows fastest: pending tool
	// results collapse into one message, so a fan-out of parallel calls
	// appends many blocks in a single turn and pushes the prior boundary
	// out of reach. The tools and system tiers keep hitting through their
	// own breakpoints, which is what made the miss invisible.
	const anchored = markLastBlock(messages, messages.length - 1)
	if (anchored <= 0) return
	markLastBlock(messages, anchored - 1)
}

/**
 * Append a breakpoint to the newest non-empty message at or before `from`,
 * and return its index (or -1). A breakpoint may not follow an empty
 * message, so empties are skipped.
 */
function markLastBlock(messages: BedrockMessage[], from: number): number {
	for (let i = Math.min(from, messages.length - 1); i >= 0; i--) {
		const msg = messages[i]
		if (!msg?.content || msg.content.length === 0) continue
		msg.content.push(CACHE_POINT)
		return i
	}
	return -1
}

function toBedrockRole(role: string): ConversationRole {
	return role === 'assistant' ? 'assistant' : 'user'
}

/**
 * This service reports failures as named exception classes, and the name
 * is a better signal than anything else the error carries: it is exact,
 * stable, and set even when the status is not.
 *
 * Without this mapping a throttle reached the runtime as an unclassified
 * error, which is treated as non-retryable — so the retry policy was
 * effectively dead on this driver, and the one failure most worth backing
 * off from was the one that killed the run.
 */
const EXCEPTION_CODES: Readonly<Record<string, ProviderErrorCode>> = {
	ThrottlingException: 'rate_limit',
	TooManyRequestsException: 'rate_limit',
	ServiceQuotaExceededException: 'rate_limit',
	ServiceUnavailableException: 'overloaded',
	ModelNotReadyException: 'overloaded',
	ModelTimeoutException: 'timeout',
	InternalServerException: 'server_error',
	ModelStreamErrorException: 'server_error',
	AccessDeniedException: 'auth',
	ResourceNotFoundException: 'not_found',
	// `ValidationException` is deliberately absent — see BODY_DEPENDENT.
}

/**
 * Exception names whose meaning depends on the body rather than the name.
 *
 * `ValidationException` covers both a malformed request and a prompt past
 * the model's window, and only one of those is recoverable. Pre-filing it
 * as `invalid_request` made the recoverable one unrecoverable by
 * construction: the shared classifier short-circuits on an error that
 * already carries a code, so the body was never read and the overflow
 * rescue could never fire.
 *
 * These are handed to the shared classifier, which reads the body and
 * falls back to the status in the metadata bag. The result is still a
 * `ProviderError`, so the driver's contract is unchanged — it just stops
 * answering a question it cannot answer from the name alone.
 */
const BODY_DEPENDENT: ReadonlySet<string> = new Set(['ValidationException'])

/**
 * Run a request, turning a named service exception into a classified
 * {@link ProviderError} the runtime can act on.
 *
 * Wrapping here rather than teaching the shared classifier these names: a
 * driver knows its own vendor's error vocabulary, and the classifier
 * should stay generic. It already short-circuits on an error that is
 * already a `ProviderError`.
 */
async function sendClassified<T>(send: () => Promise<T>, providerId: string): Promise<T> {
	try {
		return await send()
	} catch (err) {
		if (isAbortError(err)) throw err

		const name = (err as { name?: string })?.name ?? ''
		if (BODY_DEPENDENT.has(name)) throw classifyProviderError(err, providerId)

		const code = EXCEPTION_CODES[name]
		if (!code) throw err

		const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
		throw new ProviderError({
			code,
			message: err instanceof Error ? err.message : String(err),
			providerId,
			...(status !== undefined ? { status } : {}),
			cause: err,
		})
	}
}

/** Image media types this wire format accepts, mapped to its format name. */
const IMAGE_FORMATS: Readonly<Record<string, ImageFormat>> = {
	'image/png': 'png',
	'image/jpeg': 'jpeg',
	'image/gif': 'gif',
	'image/webp': 'webp',
}

/**
 * Turn a tool result into content blocks this wire format understands.
 *
 * Converse carries images natively, so an image block goes through as an
 * image rather than a placeholder — a downgrade the other drivers accept
 * only because their wire is text-only. Before this the whole content was
 * `JSON.stringify`d, which dumped a screenshot's base64 payload into the
 * prompt as JSON text: unreadable to the model and ruinous in tokens.
 *
 * A media type Converse does not accept still degrades to a named
 * placeholder rather than being smuggled through as text.
 */
export function toToolResultBlocks(content: unknown): ToolResultContentBlock[] {
	if (typeof content === 'string') return [{ text: content }]
	if (!Array.isArray(content)) return [{ text: toolResultToText(content as never) }]

	const blocks: ToolResultContentBlock[] = []
	for (const block of content as readonly Record<string, unknown>[]) {
		if (block.type === 'text' && typeof block.text === 'string') {
			blocks.push({ text: block.text })
			continue
		}
		if (block.type === 'image' && typeof block.data === 'string') {
			const format = IMAGE_FORMATS[String(block.mediaType)]
			if (format) {
				blocks.push({ image: { format, source: { bytes: base64ToBytes(block.data) } } })
				continue
			}
		}
		// Anything else: name it honestly instead of inlining its payload.
		blocks.push({ text: toolResultToText([block] as never) })
	}

	// A tool result must not be empty on the wire.
	return blocks.length > 0 ? blocks : [{ text: '' }]
}

function base64ToBytes(data: string): Uint8Array {
	return Uint8Array.from(Buffer.from(data, 'base64'))
}

/** Exported for tests: the tool-result mapping is the seam that dropped `isError`. */
export function toBedrockMessages(messages: ChatCompletionParams['messages']): BedrockMessage[] {
	const out: BedrockMessage[] = []

	let pendingToolResults: ContentBlock[] = []

	const flushToolResults = () => {
		if (pendingToolResults.length > 0) {
			out.push({ role: 'user', content: pendingToolResults })
			pendingToolResults = []
		}
	}

	for (const msg of messages) {
		if (msg.role === 'system') continue

		if (msg.role === 'tool') {
			const toolMsg = msg as {
				toolCallId?: string
				content?: unknown
				isError?: boolean
			}
			pendingToolResults.push({
				toolResult: {
					toolUseId: toolMsg.toolCallId ?? 'unknown',
					content: toToolResultBlocks(toolMsg.content),
					// Converse has a first-class `status` for a failed tool
					// result, and it was being dropped: the executor computed
					// `isError`, the SSE and A2A bridges carried it, and then
					// the driver flattened every failure into an ordinary
					// success. The model's trained tool-failure recovery path
					// keys off this, so without it namzu was relying on prose
					// formatting to convey "that call failed".
					...(toolMsg.isError ? { status: 'error' as const } : {}),
				},
			})
			continue
		}

		flushToolResults()

		if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
			const content: ContentBlock[] = []
			if (msg.content) {
				content.push({ text: msg.content })
			}
			for (const tc of msg.toolCalls) {
				content.push({
					toolUse: {
						toolUseId: tc.id,
						name: tc.function.name,
						input: JSON.parse(tc.function.arguments || '{}'),
					},
				})
			}
			out.push({ role: 'assistant', content })
			continue
		}

		const text = typeof msg.content === 'string' ? msg.content : toolResultToText(msg.content ?? '')
		const content: ContentBlock[] = []
		if (text.length > 0) content.push({ text })

		// Attachments were dropped here entirely, so a user who attached a
		// screenshot got a turn about nothing. This wire carries an image as
		// raw bytes beside the text.
		if (msg.role === 'user' && msg.attachments) {
			for (const attachment of msg.attachments) {
				const format = IMAGE_FORMATS[attachment.mediaType.toLowerCase()]
				if (format) {
					content.push({ image: { format, source: { bytes: base64ToBytes(attachment.data) } } })
					continue
				}
				// A format the service rejects would fail the whole request,
				// so it is named instead of sent.
				content.push({ text: `[image: ${attachment.mediaType} — unsupported format, not sent]` })
			}
		}

		// A message with no content at all is rejected on the wire.
		out.push({
			role: toBedrockRole(msg.role),
			content: content.length > 0 ? content : [{ text }],
		})
	}

	flushToolResults()

	return out
}

function messagesContainToolBlocks(messages: ChatCompletionParams['messages']): boolean {
	for (const msg of messages) {
		if (msg.role === 'tool') return true
		if (
			msg.role === 'assistant' &&
			'toolCalls' in msg &&
			msg.toolCalls &&
			msg.toolCalls.length > 0
		) {
			return true
		}
	}
	return false
}

function extractToolNamesFromHistory(messages: ChatCompletionParams['messages']): string[] {
	const names = new Set<string>()
	for (const msg of messages) {
		if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				names.add(tc.function.name)
			}
		}
	}
	return Array.from(names)
}

function toBedrockToolConfig(
	params: ChatCompletionParams,
	cachingEnabled: boolean,
): ToolConfiguration | undefined {
	if (params.tools && params.tools.length > 0) {
		const tools: Tool[] = params.tools.map(
			(t) =>
				({
					toolSpec: {
						name: t.function.name,
						description: t.function.description ?? '',
						inputSchema: {
							json: (t.function.parameters ?? {}) as Record<string, unknown>,
						},
					},
				}) as Tool,
		)

		// Tools render at position 0 of the cache prefix, so a breakpoint
		// here holds every schema even when the breakpoints downstream are
		// invalidated by a changed conversation.
		if (cachingEnabled) tools.push(CACHE_POINT as Tool)

		const toolChoice = formatToolChoice(params.toolChoice)
		return { tools, toolChoice }
	}

	if (messagesContainToolBlocks(params.messages)) {
		const toolNames = extractToolNamesFromHistory(params.messages)
		if (toolNames.length > 0) {
			const tools: Tool[] = toolNames.map(
				(name) =>
					({
						toolSpec: {
							name,
							description: '(completed)',
							inputSchema: { json: { type: 'object' } },
						},
					}) as Tool,
			)
			return { tools, toolChoice: { auto: {} } }
		}
	}

	return undefined
}

function formatToolChoice(tc?: ToolChoice) {
	if (!tc || tc === 'auto') return { auto: {} }
	if (tc === 'none') return { auto: {} }
	if (tc === 'required') return { any: {} }
	if (typeof tc === 'object' && tc.type === 'function') {
		return { tool: { name: tc.function.name } }
	}
	return { auto: {} }
}

interface RawBedrockUsage {
	inputTokens?: number
	outputTokens?: number
	totalTokens?: number
	cacheReadInputTokenCount?: number
	cacheWriteInputTokenCount?: number
}

function parseUsage(raw?: RawBedrockUsage): TokenUsage {
	if (!raw) {
		return {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		}
	}
	const input = raw.inputTokens ?? 0
	const output = raw.outputTokens ?? 0
	return {
		promptTokens: input,
		completionTokens: output,
		totalTokens: raw.totalTokens ?? input + output,
		cachedTokens: raw.cacheReadInputTokenCount ?? 0,
		cacheWriteTokens: raw.cacheWriteInputTokenCount ?? 0,
	}
}

type NamzuFinishReason = ChatCompletionResponse['finishReason']

function mapStopReason(reason?: string): NamzuFinishReason {
	switch (reason) {
		case 'end_turn':
		case 'stop_sequence':
			return 'stop'
		case 'tool_use':
			return 'tool_calls'
		case 'max_tokens':
			return 'length'
		case 'content_filtered':
			return 'content_filter'
		default:
			return 'stop'
	}
}

/**
 * What this DRIVER does, not what the service could do: tools are mapped
 * onto the tool config, and an image — whether attached to a user message
 * or returned inside a tool result — travels as raw bytes beside the text
 * rather than as a placeholder. A format the service does not accept is
 * named in the text, because sending it would fail the whole request.
 */
export const BEDROCK_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
}

export class BedrockProvider implements LLMProvider {
	readonly id = 'bedrock'
	readonly name = 'AWS Bedrock'
	readonly capabilities = BEDROCK_CAPABILITIES

	private client: BedrockRuntimeClient
	private config: BedrockConfig

	constructor(config: BedrockConfig) {
		this.config = config

		const clientConfig: Record<string, unknown> = {}

		if (config.region) {
			clientConfig.region = config.region
		}

		if (config.accessKeyId && config.secretAccessKey) {
			clientConfig.credentials = {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
				...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
			}
		}

		this.client = new BedrockRuntimeClient(clientConfig)
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		// The runtime asks for caching by setting `cacheControl` on every
		// iteration; the driver decides where the breakpoints go.
		const cachingEnabled = params.cacheControl !== undefined
		const system = extractSystemBlocks(params.messages, cachingEnabled)
		const messages = toBedrockMessages(params.messages)
		if (cachingEnabled) applyMessageCacheBreakpoint(messages)
		const toolConfig = toBedrockToolConfig(params, cachingEnabled)

		const inferenceConfig: Record<string, unknown> = {}
		if (params.maxTokens !== undefined) inferenceConfig.maxTokens = params.maxTokens
		if (params.temperature !== undefined) inferenceConfig.temperature = params.temperature
		if (params.topP !== undefined) inferenceConfig.topP = params.topP
		if (params.stop) inferenceConfig.stopSequences = params.stop

		const command = new ConverseStreamCommand({
			modelId: params.model,
			system: system.length > 0 ? system : undefined,
			messages,
			toolConfig,
			inferenceConfig,
		})

		const response = await sendClassified(
			() =>
				this.client.send(command, {
					requestTimeout: this.config.timeout ?? 120_000,
					// Per-request abort: a Stop tears the in-flight stream down.
					abortSignal: params.signal,
				}),
			this.id,
		)

		if (!response.stream) {
			throw new Error('Bedrock returned no stream body')
		}

		const requestId = response.$metadata.requestId ?? `bedrock-${Date.now()}`

		const activeToolCalls = new Map<number, { id: string; name: string; args: string }>()
		let toolCallIndex = 0

		for await (const event of response.stream as AsyncIterable<ConverseStreamOutput>) {
			// Stop pulling promptly on abort; `for await` calls the stream's
			// `.return()` on this throw, releasing the connection.
			params.signal?.throwIfAborted()
			try {
				if ('contentBlockDelta' in event && event.contentBlockDelta?.delta) {
					const delta = event.contentBlockDelta.delta
					if ('text' in delta && delta.text) {
						yield {
							id: requestId,
							delta: { content: delta.text },
						}
					}

					if ('toolUse' in delta && delta.toolUse) {
						const idx = event.contentBlockDelta.contentBlockIndex ?? toolCallIndex
						const active = activeToolCalls.get(idx)
						if (active) {
							active.args += delta.toolUse.input ?? ''
							yield {
								id: requestId,
								delta: {
									toolCalls: [
										{
											index: idx,
											function: { arguments: delta.toolUse.input ?? '' },
										},
									],
								},
							}
						}
					}
				}

				if ('contentBlockStart' in event && event.contentBlockStart?.start) {
					const start = event.contentBlockStart.start
					if ('toolUse' in start && start.toolUse) {
						const idx = event.contentBlockStart.contentBlockIndex ?? toolCallIndex
						activeToolCalls.set(idx, {
							id: start.toolUse.toolUseId ?? `tool-${Date.now()}`,
							name: start.toolUse.name ?? '',
							args: '',
						})
						yield {
							id: requestId,
							delta: {
								toolCalls: [
									{
										index: idx,
										id: start.toolUse.toolUseId,
										type: 'function',
										function: { name: start.toolUse.name ?? '' },
									},
								],
							},
						}
						toolCallIndex = idx + 1
					}
				}

				if ('contentBlockStop' in event) {
				}

				if ('messageStop' in event && event.messageStop) {
					yield {
						id: requestId,
						delta: {},
						finishReason: mapStopReason(event.messageStop.stopReason),
					}
				}

				if ('metadata' in event && event.metadata?.usage) {
					const usage = parseUsage(event.metadata.usage as RawBedrockUsage)
					yield {
						id: requestId,
						delta: {},
						usage,
					}
				}
			} catch (parseErr) {
				yield {
					id: requestId,
					delta: { content: undefined },
					finishReason: undefined,
					usage: undefined,
					error: `Stream parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
				}
			}
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		return [
			{
				id: 'anthropic.claude-sonnet-4-20250514',
				name: 'Claude Sonnet 4 (Bedrock)',
				contextWindow: 200_000,
				maxOutputTokens: 64_000,
				inputPrice: 3.0,
				outputPrice: 15.0,
				supportsToolUse: true,
				supportsStreaming: true,
			},
			{
				id: 'anthropic.claude-haiku-4-20250514',
				name: 'Claude Haiku 4 (Bedrock)',
				contextWindow: 200_000,
				maxOutputTokens: 64_000,
				inputPrice: 0.8,
				outputPrice: 4.0,
				supportsToolUse: true,
				supportsStreaming: true,
			},
			{
				id: 'amazon.nova-pro-v1:0',
				name: 'Amazon Nova Pro',
				contextWindow: 300_000,
				maxOutputTokens: 5_000,
				inputPrice: 0.8,
				outputPrice: 3.2,
				supportsToolUse: true,
				supportsStreaming: true,
			},
		]
	}

	async healthCheck(): Promise<boolean> {
		try {
			const command = new ConverseCommand({
				modelId: 'anthropic.claude-haiku-4-20250514',
				messages: [{ role: 'user', content: [{ text: 'hi' }] }],
				inferenceConfig: { maxTokens: 1 },
			})
			const response = await this.client.send(command, {
				requestTimeout: 5000,
			})
			return response.$metadata.httpStatusCode === 200
		} catch {
			return false
		}
	}
}
