import { randomUUID } from 'node:crypto'
import { assertThinkingUnsupported } from '@namzu/sdk'
import type {
	ChatCompletionParams,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	TokenUsage,
} from '@namzu/sdk'
import { toolResultToText } from '@namzu/sdk'
import { isModelContentOmission } from '@namzu/sdk'
import {
	ProviderRequestError,
	isCallerAbortError,
	isProviderRequestError,
	providerVendorError,
} from '@namzu/sdk'
import {
	type AbortableAsyncIterator,
	type ChatResponse,
	Ollama,
	type Message as OllamaMessage,
} from 'ollama'
import { withRequestTimeout } from './request-timeout.js'
import type { OllamaConfig } from './types.js'

/**
 * What this DRIVER does, not what the Ollama server could do:
 * `chatStream` never reads `params.tools` (no tool schemas reach the
 * model), while pictures are mapped: a user message's image attachments and
 * the image blocks of a tool result go out as the message's `images` array.
 * Whether a given MODEL reads them is answered per model by
 * `supportsImageInputFor`, from the server's own model information.
 */
export const OLLAMA_CAPABILITIES: ProviderCapabilities = {
	supportsTools: false,
	supportsStreaming: true,
	supportsFunctionCalling: false,
	supportsVision: true,
	// Images only. A document degrades to a named placeholder.
	supportsDocuments: false,
	supportsToolResultImages: true,
	supportsToolResultDocuments: false,
}

const DEFAULT_HOST = 'http://localhost:11434'

function resolveHost(config: OllamaConfig): string {
	if (config.host) return config.host
	const envHost = process.env.OLLAMA_HOST
	if (envHost && envHost.length > 0) return envHost
	return DEFAULT_HOST
}

function encodedSize(base64: string): string {
	const bytes = Math.floor((base64.length * 3) / 4)
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** What stands in for a picture when the model is known not to read one. */
function imageMarker(mediaType: string, base64: string): string {
	return `[image omitted: the current model cannot read images (${mediaType}, ${encodedSize(base64)})]`
}

function withMarkers(text: string, markers: string[]): string {
	if (markers.length === 0) return text
	return text.length > 0 ? `${text}\n\n${markers.join('\n\n')}` : markers.join('\n\n')
}

/**
 * Ollama takes a message's pictures as an `images` array of base64 strings on
 * any role. A tool result's pictures go on the tool message itself. When the
 * model is known not to read pictures they become a short note instead, never
 * silently nothing.
 */
export function toOllamaMessages(
	messages: ChatCompletionParams['messages'],
	imagesReadable = true,
): OllamaMessage[] {
	return messages.map((msg): OllamaMessage => {
		if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
			const images: string[] = []
			const markers: string[] = []
			for (const attachment of msg.attachments) {
				// Only inline images have a wire form. A document is a placeholder
				// by the runtime, a stored reference is resolved before this point,
				// and an image already withheld from the model stays withheld.
				if (attachment.type === 'stored' || attachment.type === 'document') continue
				if (isModelContentOmission(attachment.modelOmission)) continue
				if (imagesReadable) images.push(attachment.data)
				else markers.push(imageMarker(attachment.mediaType, attachment.data))
			}
			return {
				role: msg.role,
				content: withMarkers(msg.content, markers),
				...(images.length > 0 ? { images } : {}),
			}
		}
		if (msg.role === 'tool' && Array.isArray(msg.content)) {
			const images: string[] = []
			const parts: string[] = []
			for (const block of msg.content) {
				if (block.type === 'text') parts.push(block.text)
				else if (block.type === 'image') {
					if (isModelContentOmission(block.modelOmission)) continue
					if (imagesReadable) {
						images.push(block.data)
						parts.push(`[image: ${block.mediaType}, attached to this message]`)
					} else parts.push(imageMarker(block.mediaType, block.data))
				} else parts.push(toolResultToText([block]))
			}
			return {
				role: msg.role,
				content: parts.join('\n'),
				...(images.length > 0 ? { images } : {}),
			}
		}
		return {
			role: msg.role,
			// A tool result can be content BLOCKS now; this wire takes text, so
			// flatten rather than hand it an array it cannot read.
			content: typeof msg.content === 'string' ? msg.content : toolResultToText(msg.content ?? ''),
		}
	})
}

function carriesImages(messages: ChatCompletionParams['messages']): boolean {
	return messages.some(
		(msg) =>
			(msg.role === 'user' &&
				(msg.attachments ?? []).some((a) => a.type !== 'stored' && a.type !== 'document')) ||
			(msg.role === 'tool' &&
				Array.isArray(msg.content) &&
				msg.content.some((b) => b.type === 'image')),
	)
}

/**
 * Ollama's `done_reason` in the SDK's vocabulary. `length` is the one that
 * matters: it is what the iteration loop's auto-continuation branch reads.
 * Anything unrecognised stays 'stop' — the conservative answer, because claiming
 * a truncation that did not happen would trigger a pointless continuation.
 */
function mapDoneReason(reason: string | undefined): StreamChunk['finishReason'] {
	switch (reason) {
		case 'length':
			return 'length'
		case 'stop':
			return 'stop'
		default:
			return 'stop'
	}
}

function buildUsage(resp: Pick<ChatResponse, 'prompt_eval_count' | 'eval_count'>): TokenUsage {
	const promptTokens = resp.prompt_eval_count ?? 0
	const completionTokens = resp.eval_count ?? 0
	return {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

/**
 * Race the initial POST/response-handshake against Stop.
 *
 * The ollama SDK creates its private AbortController inside the request and
 * exposes it only on the resolved iterator. If Stop wins before that point, the
 * caller still returns immediately; when the iterator eventually arrives, abort
 * it so the late connection is not left generating.
 */
async function awaitStreamStart(
	operation: Promise<AbortableAsyncIterator<ChatResponse>>,
	signal?: AbortSignal,
): Promise<AbortableAsyncIterator<ChatResponse>> {
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

	void operation.then(
		(stream) => {
			if (signal.aborted) stream.abort()
		},
		() => undefined,
	)

	try {
		return await Promise.race([operation, aborted])
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort)
	}
}

export class OllamaProvider implements LLMProvider {
	readonly id = 'ollama'
	readonly name = 'Ollama'
	readonly capabilities = OLLAMA_CAPABILITIES

	private client: Ollama
	private config: OllamaConfig

	constructor(config: OllamaConfig = {}) {
		this.config = config
		this.client = new Ollama({
			host: resolveHost(config),
			fetch: withRequestTimeout(config.fetch, config.timeout),
		})
	}

	private buildOptions(params: ChatCompletionParams): Record<string, number | string[]> {
		const options: Record<string, number | string[]> = {}
		if (params.temperature !== undefined) options.temperature = params.temperature
		if (params.topP !== undefined) options.top_p = params.topP
		if (params.topK !== undefined) options.top_k = params.topK
		if (params.maxTokens !== undefined) options.num_predict = params.maxTokens
		if (params.stop) options.stop = params.stop
		return options
	}

	/**
	 * Whether each model reads pictures, as the server's own model information
	 * said (`capabilities` includes `vision`). Read once per model and kept; a
	 * server that does not list capabilities, or an answer that failed, leaves
	 * the model unknown, which counts as "reads pictures".
	 */
	private readonly vision = new Map<string, boolean>()
	private readonly visionReads = new Map<string, Promise<void>>()

	private visionOf(model: string): Promise<void> {
		let read = this.visionReads.get(model)
		if (!read) {
			read = this.client.show({ model }).then(
				(info) => {
					if (Array.isArray(info.capabilities)) {
						this.vision.set(model, info.capabilities.includes('vision'))
					}
				},
				() => {
					// Unknown, not "no": a failed read must not blind a vision model.
					this.visionReads.delete(model)
				},
			)
			this.visionReads.set(model, read)
		}
		return read
	}

	private async waitForVision(model: string, signal?: AbortSignal): Promise<void> {
		const read = this.visionOf(model)
		if (!signal) return read
		let onAbort: (() => void) | undefined
		const aborted = new Promise<never>((_resolve, reject) => {
			if (signal.aborted) return reject(signal.reason)
			onAbort = () => reject(signal.reason)
			signal.addEventListener('abort', onAbort, { once: true })
		})
		try {
			await Promise.race([read, aborted])
		} catch (err) {
			throw signal.reason ?? err
		} finally {
			if (onAbort) signal.removeEventListener('abort', onAbort)
		}
	}

	/**
	 * `false` only when the server's model information was read and does not
	 * list vision. Until it was read (or when the server does not say) the
	 * answer is `true`, and the first call starts the one read so the answer is
	 * known by the next request.
	 */
	supportsImageInputFor(model: string): boolean {
		const known = this.vision.get(model)
		if (known === undefined) void this.visionOf(model)
		return known ?? true
	}

	private resolveModel(params: ChatCompletionParams): string {
		const model = params.model || this.config.model
		if (!model) {
			throw new Error(
				'OllamaProvider: no model specified. Pass `model` on the chat params or set a default via config.',
			)
		}
		return model
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		assertThinkingUnsupported('OllamaProvider', params)
		const model = this.resolveModel(params)
		// A request without pictures never waits on, or asks for, model information.
		if (carriesImages(params.messages) && this.vision.get(model) === undefined) {
			await this.waitForVision(model, params.signal)
		}
		const messages = toOllamaMessages(params.messages, this.vision.get(model) !== false)
		const options = this.buildOptions(params)

		// The ollama SDK's `checkOk` promotes the response body's `error` field into
		// `ResponseError.message`, so an upstream that echoes a credential back has
		// already put it in the vendor error before this code runs. Classify from
		// the status, then drop the vendor error entirely — no re-throw, no `cause`.
		let stream: AbortableAsyncIterator<ChatResponse>
		try {
			params.signal?.throwIfAborted()
			stream = await awaitStreamStart(
				this.client.chat({
					model,
					messages,
					stream: true,
					...(Object.keys(options).length > 0 ? { options } : {}),
				}),
				params.signal,
			)
		} catch (err) {
			if (isCallerAbortError(err, params.signal)) throw params.signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'ollama', error: err })
		}

		// Wire the caller abort to the iterator's real teardown: `stream.abort()`
		// calls the underlying AbortController so the fetch is cancelled and the
		// ollama server stops generating. A bare for-await `.return()` does NOT
		// release the connection (the SDK's reader loop has no teardown), so
		// without this a Stop leaves the model generating. No-op / byte-identical
		// when the signal never aborts.
		const signal = params.signal
		const onAbort = () => stream.abort()
		if (signal?.aborted) stream.abort()
		else signal?.addEventListener('abort', onAbort, { once: true })

		const id = randomUUID()
		// The server's final message arrived. A stream that closes without it
		// was cut by the connection.
		let finished = false

		try {
			for await (const chunk of stream) {
				signal?.throwIfAborted()
				const content = chunk.message?.content
				if (content && content.length > 0) {
					yield {
						id,
						delta: { content },
					}
				}

				if (chunk.done === true) {
					finished = true
					const usage = buildUsage(chunk)
					yield {
						id,
						delta: {},
						// `done_reason` was ignored and every finish reported as 'stop', so a
						// length-truncated answer was indistinguishable from a finished one.
						// The consumer that starves on this is real: the iteration loop's
						// auto-continuation only fires on `finishReason === 'length'`, so it
						// could never fire for Ollama. The field is in the vendor's own
						// typings, so this needs no cast.
						finishReason: mapDoneReason(chunk.done_reason),
						usage,
					}
				}
			}
			if (!finished) {
				throw new ProviderRequestError({
					kind: 'network',
					providerId: 'ollama',
					detail: 'the connection closed before the response finished',
				})
			}
		} catch (err) {
			if (isCallerAbortError(err, signal)) throw signal?.reason ?? err
			if (isProviderRequestError(err)) throw err
			throw providerVendorError({ providerId: 'ollama', error: err })
		} finally {
			signal?.removeEventListener('abort', onAbort)
		}
	}

	/**
	 * A local server takes no credential, so this establishes reachability
	 * rather than authorisation — which is the whole of what "does this work?"
	 * can mean here. Declared so the answer comes from the driver rather than
	 * from a listing call that happened to throw.
	 */
	async probeCredential(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted()
		await this.client.list()
		signal?.throwIfAborted()
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		signal?.throwIfAborted()
		const resp = await this.client.list()
		signal?.throwIfAborted()
		return resp.models.map((m) => ({
			id: m.name,
			name: m.name,
			// A price this driver KNOWS, not a placeholder for one it does not.
			// Ollama serves a server the operator runs locally and bills per
			// token exactly never, so zero is the true rate. Absence would say
			// "nobody knows" — the one thing that is untrue of it — and a
			// consumer is right to read `0` here as free. See
			// `ModelInfo.inputPrice`.
			inputPrice: 0,
			outputPrice: 0,
			supportsToolUse: false,
			supportsStreaming: true,
		}))
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.client.list()
			return true
		} catch {
			return false
		}
	}
}
