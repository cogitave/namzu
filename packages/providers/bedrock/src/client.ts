import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime'
import type {
	Message as BedrockMessage,
	CachePointBlock,
	ContentBlock,
	ConversationRole,
	ConverseStreamCommandOutput,
	ConverseStreamOutput,
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
	StreamChunk,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import type { JsonSchemaDialect, ToolResultContent } from '@namzu/sdk'
import { assertThinkingUnsupported, toSchemaDialect, toolResultToText } from '@namzu/sdk'
import {
	ProviderRequestError,
	isCallerAbortError,
	isProviderRequestError,
	providerVendorError,
} from '@namzu/sdk'
import type { BedrockHealthReport } from './health.js'
import { report, reportForError } from './health.js'
import { assertModelReachable, isAnthropicServedModel } from './model-reachability.js'
import type { BedrockConfig } from './types.js'

/**
 * The marker that asks this wire to cache everything before it.
 *
 * Caching is not a flag on the request here — it is a block spliced into
 * the content, and a request without one is uncached however the caller
 * configured it. That is why nothing was cached before: the driver read
 * the cache counters faithfully and never emitted a marker, so the
 * counters were honestly zero and a caller could not tell "caching does
 * not help this workload" from "caching was never asked for".
 *
 * `default` is the only member of the wire's cache-point enum. `ttl` is
 * deliberately not set: omitting it takes the service's own default,
 * and an extended TTL is priced differently, so choosing one is a cost
 * decision rather than a translation.
 */
const CACHE_POINT: { cachePoint: CachePointBlock } = { cachePoint: { type: 'default' } }

/**
 * System text, with a cache point after the last STATIC block.
 *
 * Position is the whole point, not presence. The runtime tags its static
 * segment `'cache'` and its per-run dynamic segment `'ephemeral'`, and a
 * marker appended at the end of the array would put the dynamic text
 * inside the cached prefix — which changes every run, so every read would
 * miss and every write would be paid for. A caller would see cache writes
 * and no reads, which looks like a cold cache forever.
 *
 * No static block means no system breakpoint, rather than a breakpoint in
 * an arbitrary place.
 */
function extractSystemBlocks(
	messages: ChatCompletionParams['messages'],
	cachingEnabled = false,
): SystemContentBlock[] {
	const blocks: SystemContentBlock[] = []
	let lastStatic = -1

	for (const m of messages) {
		if (m.role !== 'system') continue
		blocks.push({ text: typeof m.content === 'string' ? m.content : '' })
		if (m.cacheHint === 'cache') lastStatic = blocks.length - 1
	}

	if (cachingEnabled && lastStatic >= 0) blocks.splice(lastStatic + 1, 0, CACHE_POINT)

	return blocks
}

/**
 * The final cache point: after the last content block of the last
 * non-empty message.
 *
 * An iteration only appends messages, so caching the whole conversation
 * prefix here is what makes the NEXT turn read its history at cache rates
 * — which on a long run is the largest single cost lever available.
 */
function applyMessageCachePoint(messages: BedrockMessage[]): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const content = messages[i]?.content
		if (content && content.length > 0) {
			content.push(CACHE_POINT)
			return
		}
	}
}

function toBedrockRole(role: string): ConversationRole {
	return role === 'assistant' ? 'assistant' : 'user'
}

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
			const toolMsg = msg as { toolCallId?: string; content?: ToolResultContent }
			// `JSON.stringify` used to run here, so a tool result carrying an
			// image sent the model a wall of quoted base64: unreadable, and
			// paid for by the character. This driver does not map image
			// content, so the honest form is the SDK's named placeholder —
			// which says what was there and how big it was.
			const resultBlock: ToolResultContentBlock = {
				text: toolResultToText(toolMsg.content ?? ''),
			}
			pendingToolResults.push({
				toolResult: {
					toolUseId: toolMsg.toolCallId ?? 'unknown',
					content: [resultBlock],
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

		const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
		out.push({
			role: toBedrockRole(msg.role),
			content: [{ text }],
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

export function toBedrockToolConfig(
	params: ChatCompletionParams,
	cachingEnabled = false,
): ToolConfiguration | undefined {
	// 'none' means the model must not call a tool. This used to map to the
	// wire's 'auto', which means it MAY — the opposite, and silent. No wire
	// format lets a model call a tool it was never given, so send none.
	if (params.toolChoice === 'none') return undefined

	if (params.tools && params.tools.length > 0) {
		// Claude reached through Converse is still Claude: its serving layer
		// validates `inputSchema.json` as JSON Schema 2020-12, so a tuple
		// rendered in draft-07's `items: [a, b]` spelling fails here for the
		// same reason it fails on the direct wire. Converse carries other
		// vendors too, and nothing says they read 2020-12, so the conversion
		// follows the model rather than the endpoint.
		const dialect: JsonSchemaDialect = isAnthropicServedModel(params.model) ? '2020-12' : 'draft-07'
		const tools: Tool[] = params.tools.map(
			(t) =>
				({
					toolSpec: {
						name: t.function.name,
						description: t.function.description ?? '',
						inputSchema: {
							json: toSchemaDialect(
								(t.function.parameters ?? {}) as Record<string, unknown>,
								dialect,
							),
						},
					},
				}) as Tool,
		)

		// After the schemas, so the tool block — the largest fixed prefix on
		// a tool-using run, and the one that changes least — is cached.
		//
		// The reconstruction path below deliberately does not get one. Those
		// are placeholder specs minted to keep the wire happy when history
		// references a tool the caller no longer passes; their descriptions
		// are the literal string `(completed)`, so caching them would pin a
		// prefix that is not the caller's tool set.
		if (cachingEnabled) tools.push(CACHE_POINT)

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

/** 'none' never reaches here — it is answered by omitting the tools. */
function formatToolChoice(tc?: ToolChoice) {
	if (!tc || tc === 'auto') return { auto: {} }
	if (tc === 'required') return { any: {} }
	if (typeof tc === 'object' && tc.type === 'function') {
		return { tool: { name: tc.function.name } }
	}
	return { auto: {} }
}

/**
 * The failure Bedrock reported as a stream EVENT rather than as a throw.
 *
 * Several post-handshake failures arrive as members of the output union, after
 * a 200. Ignoring them makes a throttled or failed stream look like a clean
 * EOF — which is why this is read on the request path, and why the health probe
 * reads it through the same function rather than through a second copy that
 * could drift from this one.
 */
export function streamFailureIn(event: ConverseStreamOutput): unknown {
	return (
		('internalServerException' in event ? event.internalServerException : undefined) ??
		('modelStreamErrorException' in event ? event.modelStreamErrorException : undefined) ??
		('validationException' in event ? event.validationException : undefined) ??
		('throttlingException' in event ? event.throttlingException : undefined) ??
		('serviceUnavailableException' in event ? event.serviceUnavailableException : undefined)
	)
}

interface RawBedrockUsage {
	inputTokens?: number
	outputTokens?: number
	totalTokens?: number
	cacheReadInputTokenCount?: number
	cacheWriteInputTokenCount?: number
}

export function parseBedrockUsage(raw?: RawBedrockUsage): TokenUsage {
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
 * What this DRIVER does, not what Bedrock could do: tools are mapped
 * to the Converse toolConfig, but user-message image `attachments`
 * are not mapped into image content blocks — `supportsVision` stays
 * false until the message translation handles them.
 */
export const BEDROCK_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: false,
	// Images only. A document degrades to a named placeholder.
	supportsDocuments: false,
	supportsToolResultImages: false,
	supportsToolResultDocuments: false,
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
		assertThinkingUnsupported('BedrockProvider', params)
		// Before any AWS call: an unreachable model id fails here with the
		// reason and the fix, rather than as an opaque validation error from
		// a service that was asked for something this wire does not carry.
		assertModelReachable(params.model)

		// The runtime asks for caching on every iteration by setting
		// `cacheControl`. Honouring it costs three cache points — tools tail,
		// static-system tail, last message — and the prompt is assembled
		// tools → system → messages, so each later point also covers every
		// section before it.
		//
		// Gated on the model family for the reason `isAnthropicServedModel`
		// already exists: Converse is a multi-vendor wire, and prompt caching
		// is a property of the models on it rather than of the wire. The gate
		// fails toward today's behaviour — a model outside it sends exactly
		// the bytes it sends now, uncached — because the alternative failure
		// is a rejected request, which costs a caller a working integration
		// rather than a discount they never had.
		const cachingEnabled = params.cacheControl !== undefined && isAnthropicServedModel(params.model)

		const system = extractSystemBlocks(params.messages, cachingEnabled)
		const messages = toBedrockMessages(params.messages)
		if (cachingEnabled) applyMessageCachePoint(messages)
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

		// AWS models failures as distinct exception CLASSES rather than status
		// codes (ThrottlingException, ValidationException, AccessDeniedException),
		// and lets them escape verbatim. Classify from the class name, then drop
		// the AWS error — no re-throw, no `cause`.
		let response: ConverseStreamCommandOutput
		try {
			response = await this.client.send(command, {
				requestTimeout: this.config.timeout ?? 120_000,
				// Per-request abort: a Stop tears the in-flight Converse stream down.
				abortSignal: params.signal,
			})
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'bedrock', error: err })
		}

		if (!response.stream) {
			throw new ProviderRequestError({
				kind: 'server',
				providerId: 'bedrock',
				detail: 'the response contained no stream body',
			})
		}

		const requestId = response.$metadata.requestId ?? `bedrock-${Date.now()}`

		const activeToolCalls = new Map<number, { id: string; name: string; args: string }>()
		let toolCallIndex = 0

		try {
			for await (const event of response.stream as AsyncIterable<ConverseStreamOutput>) {
				// Stop pulling promptly on abort; `for await` calls the stream's
				// `.return()` on this throw, releasing the connection.
				params.signal?.throwIfAborted()

				// Bedrock reports several post-handshake failures as UNION
				// EVENTS, not thrown exceptions. Ignoring these members makes a
				// throttled or failed stream look like a clean EOF.
				const streamFailure = streamFailureIn(event)
				if (streamFailure) {
					throw providerVendorError({
						providerId: 'bedrock',
						error: streamFailure,
					})
				}

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
						const usage = parseBedrockUsage(event.metadata.usage as RawBedrockUsage)
						yield {
							id: requestId,
							delta: {},
							usage,
						}
					}
				} catch (parseErr) {
					if (isProviderRequestError(parseErr)) throw parseErr
					throw new ProviderRequestError({
						kind: 'server',
						providerId: 'bedrock',
						detail: 'the provider stream returned malformed data',
					})
				}
			}
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'bedrock', error: err })
		}
	}

	/**
	 * The menu this driver offers.
	 *
	 * Every Claude id here is the `bedrock-runtime` Model ID from the vendor's
	 * own model card, and that is a correction rather than a preference: the
	 * two entries this list used to carry — `anthropic.claude-sonnet-4-20250514`
	 * and `anthropic.claude-haiku-4-20250514` — are ids `assertModelReachable`
	 * refuses, so an operator picking either off the menu got a throw before any
	 * request was built. A catalogue its own request path rejects is worse than
	 * a short one.
	 *
	 * The card for Claude Haiku 4.5 is what settles that the predicate is right
	 * rather than too strict. It lists the SAME model under two ids on two
	 * endpoints: `anthropic.claude-haiku-4-5-20251001-v1:0` on
	 * `bedrock-runtime`, and the unversioned `anthropic.claude-haiku-4-5` on
	 * `bedrock-mantle`, at a different URL. The bare form is a real id for the
	 * endpoint this driver does not speak — which is exactly the claim
	 * `model-reachability.ts` makes, stated by the vendor in one table.
	 *
	 * "Claude Haiku 4" was never a model. The Haiku line goes 3.5 to 4.5, and
	 * the id that shipped here carried Sonnet 4's launch date.
	 *
	 * `inputPrice`/`outputPrice` are per million tokens and are DISPLAY data:
	 * `resolveModelPricing` in `@namzu/sdk` has no `bedrock` vendor, so no run
	 * is costed from them. The Haiku 4.5 rates are the reviewed ones from that
	 * package's own `rates.source.json`. AWS publishes Bedrock's on-demand rates
	 * on a page that renders them client-side, so they could not be read here,
	 * and if Bedrock diverges from the vendor's list price this row is wrong in
	 * that direction only.
	 */
	async listModels(): Promise<ModelInfo[]> {
		return [
			{
				id: 'anthropic.claude-sonnet-4-20250514-v1:0',
				name: 'Claude Sonnet 4 (Bedrock)',
				contextWindow: 200_000,
				maxOutputTokens: 64_000,
				inputPrice: 3.0,
				outputPrice: 15.0,
				supportsToolUse: true,
				supportsStreaming: true,
			},
			{
				id: 'anthropic.claude-haiku-4-5-20251001-v1:0',
				name: 'Claude Haiku 4.5 (Bedrock)',
				contextWindow: 200_000,
				maxOutputTokens: 64_000,
				inputPrice: 1.0,
				outputPrice: 5.0,
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

	/**
	 * Can this driver serve `model` right now?
	 *
	 * One bit, and deliberately still one bit. Widening the return type would
	 * break every caller that writes `if (await provider.healthCheck())`
	 * SILENTLY — the code keeps compiling and starts always passing, because a
	 * result object is truthy. {@link doctorCheck} is the same probe with its
	 * reasoning intact, and is what to call when the answer matters.
	 *
	 * `model` is required in practice though the type says optional: this
	 * driver's config holds no model, so with nothing passed there is nothing to
	 * probe, and the answer is `false` for the stated reason `no-model` rather
	 * than for a guessed one. It used to probe a hardcoded id instead, which is
	 * how it came to send an id its own reachability rule rejects and report the
	 * refusal as an outage.
	 */
	async healthCheck(model?: string): Promise<boolean> {
		return (await this.doctorCheck(model)).status === 'pass'
	}

	/**
	 * The health probe, with the reason it reached its verdict.
	 *
	 * Probes with `ConverseStream` rather than `Converse` because that is the
	 * command {@link chatStream} sends. They are separate IAM actions —
	 * `bedrock:InvokeModelWithResponseStream` and `bedrock:InvokeModel` — so a
	 * probe on the other one can pass under a policy every real call fails
	 * under, which is a green check about a request nobody makes.
	 *
	 * It costs one inference of one token. Nothing cheaper on the runtime client
	 * establishes credentials, region and model reachability together, and the
	 * alternatives establish them for a permission the request path does not
	 * use.
	 */
	async doctorCheck(model?: string): Promise<BedrockHealthReport> {
		if (model === undefined || model.trim() === '') {
			return report(
				'no-model',
				'No model id was given and this driver holds none in its config, so nothing was probed. This is not a report that Bedrock is unhealthy.',
			)
		}

		const startedAt = Date.now()
		const elapsed = () => Date.now() - startedAt

		// The same rule the request path applies, applied here. Skipping it is
		// how the previous check came to send an id this driver classifies as
		// uninvokable and then read the service's refusal as an outage.
		try {
			assertModelReachable(model)
		} catch (err) {
			return report('unreachable-model', err instanceof Error ? err.message : String(err), {
				model,
				durationMs: elapsed(),
			})
		}

		try {
			const command = new ConverseStreamCommand({
				modelId: model,
				messages: [{ role: 'user', content: [{ text: 'hi' }] }],
				inferenceConfig: { maxTokens: 1 },
			})
			const response = await this.client.send(command, { requestTimeout: 5000 })

			// No branch on the status code: this SDK throws for a non-2xx, so a
			// handshake that returns at all returned success. A branch production
			// cannot enter is one only a fixture unlike production could test.
			if (!response.stream) {
				return report('service', 'bedrock accepted the request and returned no stream body', {
					model,
					durationMs: elapsed(),
				})
			}

			// The handshake is a 200 even when the model then refuses, because
			// Bedrock reports those failures as members of the output union.
			// Reading only the status would call that a pass.
			for await (const event of response.stream as AsyncIterable<ConverseStreamOutput>) {
				const failure = streamFailureIn(event)
				if (failure) return reportForError(failure, model, elapsed())
			}

			return report('ok', `bedrock served ${model}`, { model, durationMs: elapsed() })
		} catch (err) {
			return reportForError(err, model, elapsed())
		}
	}
}
