import { randomUUID } from 'node:crypto'
import { LMStudioClient } from '@lmstudio/sdk'
import type { ChatHistoryData, FileType, LLMPredictionOpts, LLMTool } from '@lmstudio/sdk'
import { toolResultToText } from '@namzu/sdk'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	TokenUsage,
} from '@namzu/sdk'
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

/** The chat shape this backend takes: parts, not a flat string. */
type WireTextPart = { type: 'text'; text: string }
type WireToolCallPart = {
	type: 'toolCallRequest'
	toolCallRequest: {
		id?: string
		type: 'function'
		name: string
		arguments?: Record<string, unknown>
	}
}
type WireToolResultPart = { type: 'toolCallResult'; content: string; toolCallId?: string }
type WireFilePart = {
	type: 'file'
	name: string
	identifier: string
	sizeBytes: number
	fileType: FileType
}

type WireMessage =
	| { role: 'system' | 'user'; content: Array<WireTextPart | WireFilePart> }
	| { role: 'assistant'; content: Array<WireTextPart | WireToolCallPart> }
	| { role: 'tool'; content: WireToolResultPart[] }

type WireTool = {
	type: 'function'
	function: {
		name: string
		description?: string
		parameters?: {
			type: 'object'
			properties: Record<string, unknown>
			required?: string[]
			additionalProperties?: boolean
			$defs?: Record<string, unknown>
		}
	}
}

/**
 * Arguments cross this boundary as a string and live on the wire as an
 * object. A malformed payload becomes `{}` rather than dropping the call:
 * a result with no call to answer has nowhere to attach.
 */
function parseArguments(raw: string): Record<string, unknown> {
	if (!raw) return {}
	try {
		const parsed: unknown = JSON.parse(raw)
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

/**
 * Image media types the vision path accepts.
 *
 * The upload takes a filename and the backend decides from the bytes, so
 * an unrecognised type is left as a text note rather than uploaded and
 * discovered to be undecodable half a turn later.
 */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
	'image/png',
	'image/jpeg',
	'image/jpg',
	'image/webp',
	'image/gif',
])

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
}

/**
 * An attachment that has been handed to the backend, keyed by the message
 * it came from.
 *
 * Unlike every other wire this driver speaks, an image cannot be inlined:
 * it is uploaded first and the message references the handle that comes
 * back. That makes the mapping asynchronous, so the upload happens ahead
 * of it and the mapping stays a pure function of what it is given.
 */
export type UploadedAttachments = ReadonlyMap<number, readonly WireFilePart[]>

/**
 * Map the conversation onto the backend's native part structure.
 *
 * Tool traffic used to be flattened into user text behind a
 * `[tool-result]` marker and the assistant's own calls were dropped
 * outright, so the model saw an answer to a question it had no record of
 * asking. The wire has first-class parts for both; this uses them.
 */
export function toWireChat(
	messages: ChatCompletionParams['messages'],
	attached: {
		uploads?: UploadedAttachments
		/** Text standing in for an attachment that could not be sent. */
		notes?: ReadonlyMap<number, readonly string[]>
	} = {},
): {
	messages: WireMessage[]
} {
	const out: WireMessage[] = []
	let index = -1

	for (const msg of messages) {
		index++
		if (msg.role === 'tool') {
			// `toolResultToText` rather than `JSON.stringify`: stringifying a
			// content-block array dumps an image's base64 payload into the
			// prompt as JSON text — unreadable to the model and ruinous in
			// tokens. The helper names the block and its size instead.
			out.push({
				role: 'tool',
				content: [
					{
						type: 'toolCallResult',
						content: toolResultToText(msg.content ?? ''),
						toolCallId: msg.toolCallId,
					},
				],
			})
			continue
		}

		if (msg.role === 'assistant') {
			const parts: Array<WireTextPart | WireToolCallPart> = []
			if (msg.content) parts.push({ type: 'text', text: msg.content })
			for (const call of msg.toolCalls ?? []) {
				parts.push({
					type: 'toolCallRequest',
					toolCallRequest: {
						id: call.id,
						type: 'function',
						name: call.function.name,
						arguments: parseArguments(call.function.arguments),
					},
				})
			}
			// An assistant turn with no parts at all is not a turn; keep an
			// empty text part so the alternation the template expects holds.
			out.push({
				role: 'assistant',
				content: parts.length > 0 ? parts : [{ type: 'text', text: '' }],
			})
			continue
		}

		const body = typeof msg.content === 'string' ? msg.content : toolResultToText(msg.content ?? '')
		const files = attached.uploads?.get(index) ?? []
		const text = [body, ...(attached.notes?.get(index) ?? [])]
			.filter((part) => part.length > 0)
			.join('\n')
		const parts: Array<WireTextPart | WireFilePart> = []
		if (text.length > 0 || files.length === 0) parts.push({ type: 'text', text })
		parts.push(...files)
		out.push({
			role: msg.role === 'system' ? 'system' : 'user',
			content: parts,
		})
	}

	return { messages: out }
}

export function toWireTools(tools: ChatCompletionParams['tools']): WireTool[] {
	return (tools ?? []).map((tool) => ({
		type: 'function',
		function: {
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters as WireTool['function']['parameters'],
		},
	}))
}

function normalizeBaseUrl(host: string | undefined): string | undefined {
	if (!host) return undefined
	// The SDK dials over a websocket. Accept http(s) for ergonomics and convert.
	return host.replace(/^http(s?):\/\//, 'ws$1://')
}

/**
 * What this DRIVER does, not what the backend could do.
 *
 * The driver sends tool schemas, maps the conversation onto the native
 * part structure (the assistant's own calls and each result as
 * first-class parts rather than text folded into a user turn), surfaces
 * tool calls as the backend parses them, and forwards reasoning
 * fragments.
 *
 * Vision goes through an upload: an image cannot be inlined on this wire,
 * so each user attachment is handed to the backend first and the message
 * references the handle that comes back. An upload that fails leaves a
 * text note naming the image rather than taking the turn down.
 *
 * An image inside a TOOL RESULT stays a text placeholder: a tool message
 * on this wire may hold result parts and nothing else, so there is nowhere
 * to reference a handle from. Moving it into a separate user turn would
 * put words in the user's mouth to make a picture fit.
 */
export const LMSTUDIO_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
}

/**
 * Minimal shape of the pieces of the backend SDK this driver drives.
 * Declared structurally so the driver can be exercised without dialing a
 * server, and so a host may supply its own already-connected client.
 */
export interface PredictionFragment {
	content: string
	reasoningType?: 'none' | 'reasoning' | 'reasoningStartTag' | 'reasoningEndTag'
}

export interface PredictionHandle
	extends AsyncIterable<PredictionFragment>,
		PromiseLike<{ stats: Record<string, unknown> }> {}

export interface PredictionOptions {
	signal?: AbortSignal
	rawTools?: { type: 'none' } | { type: 'toolArray'; tools?: WireTool[]; force?: boolean }
	toolNaming?: 'passThrough' | 'removeSpecial' | 'snakeCase' | 'camelCase'
	temperature?: number
	maxTokens?: number | false
	stopStrings?: string[]
	topPSampling?: number | false
	topKSampling?: number
	repeatPenalty?: number | false
	onToolCallRequestStart?: (callId: number, info: { toolCallId?: string }) => void
	onToolCallRequestNameReceived?: (callId: number, name: string) => void
	onToolCallRequestEnd?: (
		callId: number,
		info: {
			toolCallRequest: { id?: string; name: string; arguments?: Record<string, unknown> }
		},
	) => void
	onToolCallRequestFailure?: (callId: number, error: Error) => void
}

export interface ModelHandle {
	respond(chat: { messages: WireMessage[] }, opts: PredictionOptions): PredictionHandle
}

export interface UploadedFileHandle {
	readonly identifier: string
	readonly type: FileType
	readonly sizeBytes: number
	readonly name: string
}

export interface BackendClient {
	llm: {
		model(id: string): Promise<ModelHandle>
		listLoaded(): Promise<Array<{ identifier?: string; path?: string }>>
	}
	files: {
		prepareImageBase64(fileName: string, contentBase64: string): Promise<UploadedFileHandle>
	}
}

/**
 * Hand every carriable user attachment to the backend and collect the
 * handles, keyed by the message they belong to.
 *
 * An upload that fails must not take the turn down with it: the model
 * losing sight of one image is recoverable, the run dying is not. A failed
 * or unsupported attachment is named in the text instead, so the model
 * knows something was there and that it cannot see it — which is a
 * different situation from there being no image at all.
 */
export async function uploadAttachments(
	client: BackendClient,
	messages: ChatCompletionParams['messages'],
): Promise<{ uploads: Map<number, WireFilePart[]>; notes: Map<number, string[]> }> {
	const uploads = new Map<number, WireFilePart[]>()
	const notes = new Map<number, string[]>()

	const note = (index: number, text: string) => {
		const list = notes.get(index) ?? []
		list.push(text)
		notes.set(index, list)
	}

	for (const [index, msg] of messages.entries()) {
		if (msg.role !== 'user' || !msg.attachments || msg.attachments.length === 0) continue

		for (const [n, attachment] of msg.attachments.entries()) {
			const mediaType = attachment.mediaType.toLowerCase()
			if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
				note(index, `[image: ${attachment.mediaType} — unsupported format, not sent]`)
				continue
			}
			try {
				const handle = await client.files.prepareImageBase64(
					`attachment-${index}-${n}.${IMAGE_EXTENSIONS[mediaType] ?? 'png'}`,
					attachment.data,
				)
				const parts = uploads.get(index) ?? []
				parts.push({
					type: 'file',
					name: handle.name,
					identifier: handle.identifier,
					sizeBytes: handle.sizeBytes,
					fileType: handle.type,
				})
				uploads.set(index, parts)
			} catch {
				note(index, `[image: ${attachment.mediaType} — upload failed, not sent]`)
			}
		}
	}

	return { uploads, notes }
}

/**
 * The client is cast when it is constructed, so nothing would otherwise
 * check that these option and message shapes still match the backend
 * SDK's. An option the SDK does not recognise is ignored in silence —
 * tools would simply stop being sent, with no error anywhere — so the
 * match is asserted at compile time instead. A rename upstream fails the
 * typecheck rather than the run.
 */
// The failure branch is `false`, not `never`: `never` is assignable to
// everything, so an assertion that fails to `never` silently passes and
// guards nothing.
type Assert<T extends true> = T
export type BackendShapesStillMatch = [
	// Every option this driver sets must still EXIST upstream. Structural
	// assignability alone does not catch this: an unrecognised extra
	// property is legal in an `extends` check and ignored at runtime, which
	// is exactly the silent failure worth guarding against.
	Assert<keyof PredictionOptions extends keyof LLMPredictionOpts ? true : false>,
	// …and still mean the same thing.
	Assert<PredictionOptions extends LLMPredictionOpts ? true : false>,
	Assert<ReturnType<typeof toWireChat> extends ChatHistoryData ? true : false>,
	Assert<WireTool extends LLMTool ? true : false>,
]

export class LMStudioProvider implements LLMProvider {
	readonly id = 'lmstudio'
	readonly name = 'LM Studio'
	readonly capabilities = LMSTUDIO_CAPABILITIES

	private client: BackendClient
	private defaultModel?: string

	constructor(config: LMStudioConfig = {}) {
		const baseUrl = normalizeBaseUrl(config.host ?? process.env.LMSTUDIO_HOST)
		this.client =
			config.client ?? (new LMStudioClient(baseUrl ? { baseUrl } : {}) as unknown as BackendClient)
		this.defaultModel = config.model
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

	private buildOptions(params: ChatCompletionParams): PredictionOptions {
		const opts: PredictionOptions = {}
		if (params.signal) opts.signal = params.signal
		if (params.temperature !== undefined) opts.temperature = params.temperature
		if (params.maxTokens !== undefined) opts.maxTokens = params.maxTokens
		if (params.stop) opts.stopStrings = params.stop
		if (params.topP !== undefined) opts.topPSampling = params.topP
		if (params.topK !== undefined) opts.topKSampling = params.topK
		if (params.repetitionPenalty !== undefined) opts.repeatPenalty = params.repetitionPenalty

		const tools = toWireTools(params.tools)
		if (params.toolChoice === 'none') {
			opts.rawTools = { type: 'none' }
		} else if (tools.length > 0) {
			opts.rawTools = {
				type: 'toolArray',
				tools,
				...(params.toolChoice === 'required' ? { force: true } : {}),
			}
			// The backend rewrites tool names before showing them to the model
			// by default, and the runtime resolves a call by its exact
			// registered name. Since the runtime owns the loop here, nothing
			// maps a rewritten name back — so the name must round-trip
			// untouched. A name a model finds confusing is a naming problem to
			// fix in the registry, not something to paper over by breaking the
			// binding.
			opts.toolNaming = 'passThrough'
		}
		return opts
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const modelId = this.resolveModel(params)
		const model = await this.client.llm.model(modelId)
		// Ahead of the mapping, because an image has to exist on the backend
		// before a message can point at it.
		const attached = await uploadAttachments(this.client, params.messages)
		const id = randomUUID()

		// Tool calls arrive through callbacks the backend fires while the
		// fragment stream is being consumed, so they cannot be yielded from
		// where they are observed. They queue here and drain at the next
		// iteration boundary, which keeps them in the order the backend
		// produced them relative to the surrounding content.
		const pending: StreamChunk[] = []
		const callIds = new Map<number, string>()
		let toolCallsSeen = 0

		const idFor = (callId: number, hinted?: string): string => {
			const existing = callIds.get(callId)
			if (existing) return existing
			// The backend's own id is preferred when it has one; the runtime
			// binds a result to its call by whichever id it saw FIRST, so the
			// same id has to be used for every frame of the call.
			const minted = hinted && hinted.length > 0 ? hinted : `${id}-${callId}`
			callIds.set(callId, minted)
			return minted
		}

		const options = this.buildOptions(params)
		options.onToolCallRequestStart = (callId, info) => {
			toolCallsSeen++
			pending.push({
				id,
				delta: {
					toolCalls: [{ index: callId, id: idFor(callId, info.toolCallId), type: 'function' }],
				},
			})
		}
		options.onToolCallRequestNameReceived = (callId, name) => {
			pending.push({
				id,
				delta: { toolCalls: [{ index: callId, id: idFor(callId), function: { name } }] },
			})
		}
		options.onToolCallRequestEnd = (callId, info) => {
			const callId_ = idFor(callId, info.toolCallRequest.id)
			// The arguments come from the backend already parsed into an
			// object. Re-serializing that is strictly safer than stitching the
			// raw argument fragments back together: the backend warns those
			// fragments are not guaranteed to be JSON, because not every model
			// expresses a call as JSON in the first place.
			pending.push({
				id,
				delta: {
					toolCalls: [
						{
							index: callId,
							id: callId_,
							type: 'function',
							function: {
								name: info.toolCallRequest.name,
								arguments: JSON.stringify(info.toolCallRequest.arguments ?? {}),
							},
						},
					],
					toolCallEnd: { index: callId, id: callId_ },
				},
			})
		}
		options.onToolCallRequestFailure = (callId, error) => {
			// A call the backend could not parse is reported, not swallowed:
			// silence here looks identical to a model that chose not to call
			// anything, and the two need different responses.
			pending.push({
				id,
				delta: {},
				error: `tool call ${callId} failed to parse: ${error.message}`,
			})
		}

		const prediction = model.respond(toWireChat(params.messages, attached), options)

		let reasoningOpen = false
		for await (const fragment of prediction) {
			// Cheap promptness check between fragments (the signal passed into
			// the prediction is the real teardown).
			params.signal?.throwIfAborted()

			while (pending.length > 0) {
				const next = pending.shift()
				if (next) yield next
			}

			if (fragment.reasoningType === 'reasoning') {
				reasoningOpen = true
				yield { id, delta: { reasoning: { index: 0, type: 'thinking', text: fragment.content } } }
				continue
			}
			if (fragment.reasoningType === 'reasoningEndTag') {
				if (reasoningOpen) {
					reasoningOpen = false
					yield { id, delta: { reasoning: { index: 0, done: true } } }
				}
				continue
			}
			// The tags themselves are structure, not content — forwarding them
			// would put a literal marker into the answer text.
			if (fragment.reasoningType === 'reasoningStartTag') continue

			if (fragment.content) {
				if (reasoningOpen) {
					reasoningOpen = false
					yield { id, delta: { reasoning: { index: 0, done: true } } }
				}
				yield { id, delta: { content: fragment.content } }
			}
		}

		while (pending.length > 0) {
			const next = pending.shift()
			if (next) yield next
		}
		if (reasoningOpen) {
			yield { id, delta: { reasoning: { index: 0, done: true } } }
		}

		const result = await prediction
		const stats = (result.stats ?? {}) as {
			stopReason?: string
			promptTokensCount?: number
			predictedTokensCount?: number
			totalTokensCount?: number
		}
		yield {
			id,
			delta: {},
			finishReason: toolCallsSeen > 0 ? 'tool_calls' : mapStopReason(stats.stopReason),
			usage: mapUsage(stats),
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		try {
			const loaded = await this.client.llm.listLoaded()
			return loaded.map((m) => {
				const identifier = m.identifier ?? ''
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
