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
	StreamChunk,
	TokenUsage,
	ToolChoice,
} from '@namzu/sdk'
import type { BedrockConfig } from './types.js'

function extractSystemBlocks(messages: ChatCompletionParams['messages']): SystemContentBlock[] {
	return messages
		.filter((m) => m.role === 'system')
		.map((m) => ({ text: typeof m.content === 'string' ? m.content : '' }))
}

function toBedrockRole(role: string): ConversationRole {
	return role === 'assistant' ? 'assistant' : 'user'
}

function toBedrockMessages(messages: ChatCompletionParams['messages']): BedrockMessage[] {
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
			const toolMsg = msg as { toolCallId?: string; content?: string }
			const resultBlock: ToolResultContentBlock = {
				text:
					typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content),
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

function toBedrockToolConfig(params: ChatCompletionParams): ToolConfiguration | undefined {
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

export class BedrockProvider implements LLMProvider {
	readonly id = 'bedrock'
	readonly name = 'AWS Bedrock'

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
		const system = extractSystemBlocks(params.messages)
		const messages = toBedrockMessages(params.messages)
		const toolConfig = toBedrockToolConfig(params)

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

		const response = await this.client.send(command, {
			requestTimeout: this.config.timeout ?? 120_000,
		})

		if (!response.stream) {
			throw new Error('Bedrock returned no stream body')
		}

		const requestId = response.$metadata.requestId ?? `bedrock-${Date.now()}`

		const activeToolCalls = new Map<number, { id: string; name: string; args: string }>()
		let toolCallIndex = 0

		for await (const event of response.stream as AsyncIterable<ConverseStreamOutput>) {
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
