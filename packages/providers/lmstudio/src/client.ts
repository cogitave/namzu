import { randomUUID } from 'node:crypto'
import { type FileHandle, LMStudioClient } from '@lmstudio/sdk'
import type {
	ChatCompletionParams,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	TokenUsage,
} from '@namzu/sdk'
import {
	ProviderRequestError,
	assertThinkingUnsupported,
	isCallerAbortError,
	isProviderRequestError,
	providerVendorError,
} from '@namzu/sdk'
import { isModelContentOmission, toolResultToText } from '@namzu/sdk'
import type { LMStudioConfig } from './types.js'

type StopReason =
	| 'eosFound'
	| 'userStopped'
	| 'modelUnloaded'
	| 'failed'
	| 'maxPredictedTokensReached'
	| 'contextLengthReached'
	| 'toolCalls'

/**
 * LM Studio's own stop reason as the finish fields of a stream chunk:
 * `finishReason`, and `finishDetail: 'context_window'` when the limit
 * reached was the model's context window rather than its output-token
 * budget.
 *
 * `maxPredictedTokensReached` and `contextLengthReached` were both folded
 * into plain `'length'`, so the runtime could not tell them apart and
 * auto-continued a reply that had filled the context window into a prompt
 * longer than the window it had just filled — exactly what `finishDetail:
 * 'context_window'` exists to stop (see `ffa399a8`, and
 * `docs/sdk/unreadable-tool-input.md`). `contextLengthReached` with content
 * is the case this maps: with none, `chatStream` above already fails the
 * turn as `context_overflow` before this ever runs.
 */
function mapStopReason(
	reason: string | undefined,
): Pick<StreamChunk, 'finishReason' | 'finishDetail'> {
	switch (reason as StopReason) {
		case 'maxPredictedTokensReached':
			return { finishReason: 'length' }
		case 'contextLengthReached':
			return { finishReason: 'length', finishDetail: 'context_window' }
		case 'toolCalls':
			return { finishReason: 'tool_calls' }
		default:
			return { finishReason: 'stop' }
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

/** One picture on its way into a message, before it has a file handle. */
interface PendingImage {
	readonly mediaType: string
	readonly data: string
}

function encodedSize(base64: string): string {
	const bytes = Math.floor((base64.length * 3) / 4)
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** What stands in for a picture when the model is known not to read one. */
function imageMarker(image: PendingImage): string {
	return `[image omitted: the current model cannot read images (${image.mediaType}, ${encodedSize(image.data)})]`
}

function appendMarkers(text: string, markers: readonly string[]): string {
	if (markers.length === 0) return text
	return text.length > 0 ? `${text}\n\n${markers.join('\n\n')}` : markers.join('\n\n')
}

/** The pictures a message carries: a user message's attachments, or a tool result's image blocks. */
function imagesOf(m: ChatCompletionParams['messages'][number]): PendingImage[] {
	const found: PendingImage[] = []
	if (m.role === 'user') {
		for (const a of m.attachments ?? []) {
			if (a.type === 'stored' || a.type === 'document') continue
			if (isModelContentOmission(a.modelOmission)) continue
			found.push({ mediaType: a.mediaType, data: a.data })
		}
	} else if (m.role === 'tool' && Array.isArray(m.content)) {
		for (const b of m.content) {
			if (b.type !== 'image' || isModelContentOmission(b.modelOmission)) continue
			found.push({ mediaType: b.mediaType, data: b.data })
		}
	}
	return found
}

/** The chat as LM Studio's SDK takes it, with each picture as a file handle it prepared. */
export interface LMStudioChatMessage {
	role: LMStudioRole
	content: string
	images?: FileHandle[]
}

/**
 * Like `toLMStudioChat`, with pictures. `prepare` turns one picture into the
 * handle the SDK attaches (`client.files.prepareImageBase64`). With
 * `imagesReadable` false every picture becomes a note instead and `prepare`
 * is never called.
 */
export async function toLMStudioChatWithImages(
	messages: ChatCompletionParams['messages'],
	prepare: (image: PendingImage, index: number) => Promise<FileHandle>,
	imagesReadable: boolean,
): Promise<LMStudioChatMessage[]> {
	const base = toLMStudioChat(messages)
	let counter = 0
	const out: LMStudioChatMessage[] = []
	for (const [i, original] of base.entries()) {
		let message = original
		const source = messages[i] as ChatCompletionParams['messages'][number]
		const pictures = imagesOf(source)
		if (pictures.length === 0) {
			out.push(message)
			continue
		}
		if (source.role === 'tool' && Array.isArray(source.content)) {
			// The generic flattening says a picture is "not renderable"; here it is
			// either attached to this message or named as left out.
			const text = source.content
				.map((block) =>
					block.type !== 'image' || isModelContentOmission(block.modelOmission)
						? toolResultToText([block])
						: imagesReadable
							? `[image: ${block.mediaType}, attached to this message]`
							: imageMarker(block),
				)
				.join('\n')
			message = { ...message, content: `[tool-result] ${text}` }
		} else if (!imagesReadable) {
			out.push({ ...message, content: appendMarkers(message.content, pictures.map(imageMarker)) })
			continue
		}
		if (!imagesReadable) {
			out.push(message)
			continue
		}
		const handles: FileHandle[] = []
		for (const picture of pictures) handles.push(await prepare(picture, counter++))
		out.push({ ...message, images: handles })
	}
	return out
}

function carriesImages(messages: ChatCompletionParams['messages']): boolean {
	return messages.some((m) => imagesOf(m).length > 0)
}

const EXTENSIONS: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
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
 * with a `[tool-result]` marker), while pictures are mapped: a user
 * message's images, and the images in a tool result, are attached to the
 * chat message as files the SDK prepares. Whether a loaded model reads
 * them is answered per model by `supportsImageInputFor`, from the SDK's
 * own model information.
 */
export const LMSTUDIO_CAPABILITIES: ProviderCapabilities = {
	supportsTools: false,
	supportsStreaming: true,
	supportsFunctionCalling: false,
	supportsVision: true,
	// Images only. A document degrades to a named placeholder.
	supportsDocuments: false,
	supportsToolResultImages: true,
	supportsToolResultDocuments: false,
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
	/** Whether each model reads pictures, as the SDK's model information said. */
	private readonly vision = new Map<string, boolean>()

	/**
	 * `false` only when the SDK's model information for `model` said it is not
	 * vision-enabled. Before a model was looked at (a listing or a first chat
	 * request), or when the SDK does not say, the answer is `true`: nothing
	 * here opens a connection just to be asked.
	 */
	supportsImageInputFor(model: string): boolean {
		return this.vision.get(model) ?? true
	}

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
		assertThinkingUnsupported('LMStudioProvider', params)
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
			const vision = (model as { vision?: unknown }).vision
			if (typeof vision === 'boolean') this.vision.set(modelId, vision)
			const files = this.client.files
			const messages = carriesImages(params.messages)
				? await awaitRequestStart(
						toLMStudioChatWithImages(
							params.messages,
							(image, index) =>
								files.prepareImageBase64(
									`image-${index + 1}.${EXTENSIONS[image.mediaType] ?? 'png'}`,
									image.data,
								),
							this.vision.get(modelId) !== false,
						),
						signal,
					)
				: toLMStudioChat(params.messages)
			const prediction = model.respond(messages, {
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

			// The server never said why it stopped: the answer was cut, not
			// finished. It is a failure to try again, not a complete reply to accept.
			const stopped = result.stats.stopReason as StopReason | undefined
			if (stopped === undefined) {
				throw new ProviderRequestError({
					kind: 'network',
					providerId: 'lmstudio',
					detail: 'the connection closed before the response finished',
				})
			}
			// The server said the reply failed, or the model was unloaded under it:
			// the server's own fault, said as such, not a lost connection.
			if (stopped === 'failed' || stopped === 'modelUnloaded') {
				throw new ProviderRequestError({
					kind: 'server',
					providerId: 'lmstudio',
					detail:
						stopped === 'modelUnloaded'
							? 'the model was unloaded before the response finished'
							: 'the server reported that the response failed',
				})
			}

			// `contextLengthReached` with NO content is not a truncated answer the
			// runtime can auto-continue — the PROMPT did not fit, and the turn failed.
			// Folding it into `finishReason: 'length'` presented it as a successful,
			// empty turn with no error at all, so a caller parsed "" as the reply.
			// `contextLengthReached` AFTER content is still reported below, but as
			// `finishDetail: 'context_window'`: it is the conversation's length, not
			// this response's, and the runtime must not auto-continue it either — see
			// `mapStopReason`.
			if (result.stats.stopReason === 'contextLengthReached' && !sawContent) {
				throw new ProviderRequestError({
					kind: 'context_overflow',
					providerId: 'lmstudio',
				})
			}

			yield {
				id,
				delta: {},
				...mapStopReason(result.stats.stopReason),
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
				const vision = (m as { vision?: unknown }).vision
				if (identifier && typeof vision === 'boolean') this.vision.set(identifier, vision)
				return {
					id: identifier,
					name: identifier,
					// Known-free, like its sibling `ollama`: a local server bills
					// per token never. Kept as `0` rather than omitted so a reader
					// can still tell this driver from one that has no rates at
					// all. See `ModelInfo.inputPrice`.
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
