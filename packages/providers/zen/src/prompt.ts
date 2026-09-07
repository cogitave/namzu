import { createHash } from 'node:crypto'
import type {
	JSONValue,
	LanguageModelV3Content,
	LanguageModelV3Message,
	LanguageModelV3Prompt,
	LanguageModelV3ToolResultOutput,
	SharedV3ProviderMetadata,
} from '@ai-sdk/provider'
import {
	type AssistantMessage,
	type ChatCompletionParams,
	type Message,
	type MessageAttachment,
	ProviderRequestError,
	type ProviderRoute,
	type ReasoningBlock,
	type ToolResultBlock,
	isModelContentOmission,
} from '@namzu/sdk'
import type { ZenProtocol, ZenService } from './models.js'

type NativePart = Extract<LanguageModelV3Content, { type: 'text' | 'reasoning' | 'tool-call' }>
type AssistantContent = Extract<LanguageModelV3Message, { role: 'assistant' }>['content']
type RichOutput = Extract<LanguageModelV3ToolResultOutput, { type: 'content' }>['value']

class HistoryConversionError extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function jsonValue(value: unknown, depth = 0): value is JSONValue {
	if (depth > 40) return false
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
	if (typeof value === 'number') return Number.isFinite(value)
	if (Array.isArray(value)) return value.every((item) => jsonValue(item, depth + 1))
	const object = record(value)
	return (
		object !== undefined &&
		(Object.getPrototypeOf(object) === Object.prototype ||
			Object.getPrototypeOf(object) === null) &&
		Object.values(object).every((item) => item === undefined || jsonValue(item, depth + 1))
	)
}

function metadata(value: unknown): value is SharedV3ProviderMetadata | undefined {
	const object = record(value)
	return (
		value === undefined ||
		(object !== undefined &&
			jsonValue(value) &&
			Object.values(object).every((namespace) => record(namespace) !== undefined))
	)
}

function parseNativeParts(value: unknown): NativePart[] | undefined {
	if (!Array.isArray(value)) return undefined
	const parts: NativePart[] = []
	for (const item of value) {
		const part = record(item)
		if (!part || !metadata(part.providerMetadata)) return undefined
		const providerMetadata = part.providerMetadata
		if (part.type === 'text' || part.type === 'reasoning') {
			if (typeof part.text !== 'string') return undefined
			parts.push({
				type: part.type,
				text: part.text,
				...(providerMetadata && { providerMetadata }),
			})
		} else if (part.type === 'tool-call') {
			if (
				typeof part.toolCallId !== 'string' ||
				typeof part.toolName !== 'string' ||
				typeof part.input !== 'string' ||
				(part.providerExecuted !== undefined && part.providerExecuted !== false)
			) {
				return undefined
			}
			try {
				parsedArguments(part.input)
			} catch {
				return undefined
			}
			parts.push({
				type: 'tool-call',
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				input: part.input,
				...(providerMetadata && { providerMetadata }),
			})
		} else {
			return undefined
		}
	}
	return parts
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical)
	const object = record(value)
	if (!object) return value
	return Object.fromEntries(
		Object.keys(object)
			.sort()
			.filter((key) => object[key] !== undefined)
			.map((key) => [key, canonical(object[key])]),
	)
}

function digest(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex')
}

function sameRoute(value: unknown, route: ProviderRoute): boolean {
	const candidate = record(value)
	return (
		candidate?.providerId === route.providerId &&
		candidate.model === route.model &&
		candidate.chainIndex === route.chainIndex
	)
}

function prefixDigest(messages: readonly Message[]): string {
	return digest(
		messages.map((message) => ({
			...message,
			...(message.role === 'assistant' && {
				source: message.source && {
					type: message.source.type,
					providerId: message.source.providerId,
					model: message.source.model,
					chainIndex: message.source.chainIndex,
				},
			}),
			timestamp: undefined,
		})),
	)
}

function metadataString(part: LanguageModelV3Content, key: string): string | undefined {
	for (const namespace of Object.values(part.providerMetadata ?? {})) {
		const value = namespace[key]
		if (typeof value === 'string') return value
	}
	return undefined
}

/** Shared by stream materialization and the durable replay correspondence guard. */
export function toReasoningBlocks(content: readonly LanguageModelV3Content[]): ReasoningBlock[] {
	return content.flatMap((part): ReasoningBlock[] => {
		if (part.type !== 'reasoning') return []
		const redacted = metadataString(part, 'redactedData')
		const signature = metadataString(part, 'signature') ?? metadataString(part, 'thoughtSignature')
		const encrypted = redacted ?? metadataString(part, 'reasoningEncryptedContent')
		return [
			{
				type: redacted === undefined ? 'thinking' : 'redacted_thinking',
				text: part.text,
				...(signature !== undefined && { signature }),
				...(encrypted !== undefined && { encrypted }),
			},
		]
	})
}

function parsedArguments(input: string): unknown {
	try {
		const value: unknown = JSON.parse(input)
		if (!jsonValue(value)) throw new Error('Non-JSON argument value.')
		return value
	} catch {
		throw new HistoryConversionError(
			'Zen history contains a tool call with invalid JSON arguments.',
		)
	}
}

function projection(
	message: Pick<AssistantMessage, 'content' | 'toolCalls' | 'reasoning'>,
): unknown {
	return {
		text: message.content ?? '',
		tools: (message.toolCalls ?? []).map((call) => ({
			id: call.id,
			name: call.function.name,
			input: parsedArguments(call.function.arguments),
			truncated: call.metadata?.inputTruncated === true,
		})),
		reasoning: (message.reasoning ?? []).map((block) => ({
			type: block.type,
			text: block.text ?? '',
			signature: block.signature ?? null,
			encrypted: block.encrypted ?? null,
		})),
	}
}

function nativeProjection(content: readonly NativePart[]): unknown {
	return projection({
		content: content
			.filter((part) => part.type === 'text')
			.map((part) => part.text)
			.join(''),
		toolCalls: content.flatMap((part) =>
			part.type === 'tool-call'
				? [
						{
							id: part.toolCallId,
							type: 'function' as const,
							function: { name: part.toolName, arguments: part.input },
						},
					]
				: [],
		),
		reasoning: toReasoningBlocks(content),
	})
}

/** Save completed native parts, bound to their request and durable public projection. */
export function createReplayState(
	params: ChatCompletionParams,
	route: ProviderRoute,
	service: ZenService,
	protocol: ZenProtocol,
	content: LanguageModelV3Content[],
): unknown {
	const parts = parseNativeParts(content)
	if (!parts) return undefined
	return JSON.parse(
		JSON.stringify({
			kind: 'namzu.zen.model-content',
			version: 1,
			route,
			model: params.model,
			service,
			protocol,
			prefixDigest: prefixDigest(params.messages),
			projectionDigest: digest(nativeProjection(parts)),
			contentDigest: digest(parts),
			content: parts,
		}),
	)
}

function replayContent(
	message: AssistantMessage,
	params: ChatCompletionParams,
	index: number,
	route: ProviderRoute,
	service: ZenService,
	protocol: ZenProtocol,
): AssistantContent | undefined {
	if (message.source?.type !== 'model' || !sameRoute(message.source, route)) return undefined
	const state = record(message.source.replayState)
	if (
		state?.kind !== 'namzu.zen.model-content' ||
		state.version !== 1 ||
		!sameRoute(state.route, route) ||
		state.model !== params.model ||
		state.service !== service ||
		state.protocol !== protocol ||
		state.prefixDigest !== prefixDigest(params.messages.slice(0, index))
	)
		return undefined
	const content = parseNativeParts(state.content)
	if (
		!content ||
		state.contentDigest !== digest(content) ||
		state.projectionDigest !== digest(nativeProjection(content)) ||
		state.projectionDigest !== digest(projection(message))
	)
		return undefined
	return content.map((part) => {
		const providerOptions =
			part.providerMetadata === undefined
				? undefined
				: (JSON.parse(JSON.stringify(part.providerMetadata)) as SharedV3ProviderMetadata)
		if (part.type === 'tool-call') {
			// The compatible adapter reads Gemini call signatures from the google namespace.
			const thoughtSignature = metadataString(part, 'thoughtSignature')
			if (protocol === 'chat' && providerOptions && thoughtSignature !== undefined) {
				providerOptions.google = { ...providerOptions.google, thoughtSignature }
			}
			return {
				type: 'tool-call',
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				input: parsedArguments(part.input),
				...(providerOptions && { providerOptions }),
			}
		}
		return { type: part.type, text: part.text, ...(providerOptions && { providerOptions }) }
	})
}

function attachment(
	attachment: MessageAttachment,
): Extract<LanguageModelV3Message, { role: 'user' }>['content'] {
	if (attachment.type === 'stored') {
		throw new HistoryConversionError(
			'Zen requires stored attachments to be resolved before model delivery.',
		)
	}
	if (attachment.type === 'document') {
		if (attachment.citations)
			throw new HistoryConversionError('Zen document citations are not supported.')
		return [
			{
				type: 'file',
				data: attachment.data,
				mediaType: attachment.mediaType,
				...(attachment.name && { filename: attachment.name }),
			},
		]
	}
	if (isModelContentOmission(attachment.modelOmission)) return []
	return [{ type: 'file', data: attachment.data, mediaType: attachment.mediaType }]
}

function richOutput(blocks: readonly ToolResultBlock[]): RichOutput {
	return blocks.flatMap((block): RichOutput => {
		if (block.type === 'text') return [{ type: 'text', text: block.text }]
		if (block.type === 'image') {
			if (isModelContentOmission(block.modelOmission)) return []
			return [{ type: 'image-data', data: block.data, mediaType: block.mediaType }]
		}
		if (block.citations)
			throw new HistoryConversionError('Zen document citations are not supported.')
		return [
			{
				type: 'file-data',
				data: block.data,
				mediaType: block.mediaType,
				...(block.name && { filename: block.name }),
			},
		]
	})
}

function toolOutput(
	message: Extract<Message, { role: 'tool' }>,
	protocol: ZenProtocol,
): LanguageModelV3ToolResultOutput {
	const textOutput = (text: string): LanguageModelV3ToolResultOutput => ({
		type: message.isError ? 'error-text' : 'text',
		// Only Messages serializes error-text with a native failure flag.
		value: message.isError && protocol !== 'messages' ? `Tool execution failed.\n${text}` : text,
	})
	if (typeof message.content === 'string') {
		return textOutput(message.content)
	}
	const value = richOutput(message.content)
	if (value.every((part) => part.type === 'text')) {
		return textOutput(value.map((part) => part.text).join('\n'))
	}
	if (message.isError)
		throw new HistoryConversionError(
			'Zen cannot preserve both rich tool content and tool failure status.',
		)
	if (protocol === 'chat')
		throw new HistoryConversionError('Zen chat protocol does not support rich tool results.')
	if (
		protocol === 'messages' &&
		value.some((part) => part.type === 'file-data' && part.mediaType !== 'application/pdf')
	) {
		throw new HistoryConversionError(
			'Zen messages protocol supports only PDF documents in rich tool results.',
		)
	}
	return { type: 'content', value }
}

/** Convert public history; native metadata is admitted only by an exact replay match. */
function buildModelPrompt(
	params: ChatCompletionParams,
	route: ProviderRoute,
	service: ZenService,
	protocol: ZenProtocol,
): LanguageModelV3Prompt {
	const prompt: LanguageModelV3Prompt = []
	const toolNames = new Map<string, string>()
	for (const [index, message] of params.messages.entries()) {
		switch (message.role) {
			case 'system':
				prompt.push({ role: 'system', content: message.content })
				break
			case 'user':
				prompt.push({
					role: 'user',
					content: [
						{ type: 'text', text: message.content },
						...(message.attachments ?? []).flatMap(attachment),
					],
				})
				break
			case 'assistant': {
				for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.function.name)
				const content = replayContent(message, params, index, route, service, protocol) ?? [
					...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
					...(message.toolCalls ?? []).map((call) => ({
						type: 'tool-call' as const,
						toolCallId: call.id,
						toolName: call.function.name,
						input: parsedArguments(call.function.arguments),
					})),
				]
				// Google and Anthropic reject empty assistant turns after foreign reasoning is removed.
				if (content.length > 0) prompt.push({ role: 'assistant', content })
				break
			}
			case 'tool': {
				const toolName = toolNames.get(message.toolCallId)
				if (!toolName)
					throw new HistoryConversionError('Zen tool history is missing the preceding tool call.')
				prompt.push({
					role: 'tool',
					content: [
						{
							type: 'tool-result',
							toolCallId: message.toolCallId,
							toolName,
							output: toolOutput(message, protocol),
						},
					],
				})
				break
			}
		}
	}
	return prompt
}

export function toModelPrompt(
	params: ChatCompletionParams,
	route: ProviderRoute,
	service: ZenService,
	protocol: ZenProtocol,
): LanguageModelV3Prompt {
	try {
		return buildModelPrompt(params, route, service, protocol)
	} catch (error) {
		throw new ProviderRequestError({
			providerId: service === 'go' ? 'zen-go' : 'zen',
			kind: 'bad_request',
			detail:
				error instanceof HistoryConversionError
					? error.message
					: 'Zen cannot represent the supplied message history.',
		})
	}
}
