import { isProviderRequestError } from '../../../provider/errors.js'
import { isImageInputRefusal } from '../../../provider/image-input-refusal.js'
import type { Message } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import {
	type RequestImageIdentity,
	findSingleRequestImage,
	projectRequestRichContent,
	projectRequestWithoutImage,
	requestHasImages,
} from '../request-rich-content.js'
import type { RequestRepair } from './request-repair.js'

const IMAGE_REJECTION_PATTERNS: readonly RegExp[] = [
	/\binvalid[_ -]?image\b/i,
	/\bimage\b.{0,100}\b(?:cannot|could not|failed to)\s+(?:be\s+)?(?:decoded|processed|loaded|parsed|read)\b/i,
	/\b(?:cannot|could not|failed to)\s+(?:decode|process|load|parse|read)\b.{0,100}\bimage\b/i,
	/\bimage\b.{0,100}\b(?:malformed|corrupt|unsupported format)\b/i,
]

type ImageRejectionConfidence = 'server-confirmed' | 'heuristic'

function classifyProviderRejectedImageError(error: unknown): ImageRejectionConfidence | null {
	if (!isProviderRequestError(error) || error.kind !== 'bad_request') return null
	if (error.status === 400 && error.providerCode === 'invalid_image') return 'server-confirmed'
	const detail = error.detail ?? error.message
	return IMAGE_REJECTION_PATTERNS.some((pattern) => pattern.test(detail)) ? 'heuristic' : null
}

export function isProviderRejectedImageError(error: unknown): boolean {
	return classifyProviderRejectedImageError(error) !== null
}

function isAcceptedChunk(chunk: StreamChunk): boolean {
	if (chunk.retry !== undefined || chunk.fallback !== undefined || chunk.error !== undefined) {
		return false
	}
	return Boolean(
		chunk.delta.content ||
			chunk.delta.toolCalls?.length ||
			chunk.delta.toolCallEnd ||
			chunk.delta.reasoning ||
			chunk.delta.citation ||
			chunk.finishReason !== undefined ||
			chunk.usage !== undefined ||
			chunk.replayState !== undefined ||
			chunk.textParts !== undefined,
	)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason
}

/** The provider and model that refused a request for holding an image. */
export interface TextOnlyModelRefusal {
	readonly providerId: string
	readonly model: string | undefined
}

/** See {@link streamWithProviderRejectedImageRecovery}. */
export interface TextOnlyModelRecovery {
	/**
	 * Who is serving the request. A fallback chain reports its head's id and
	 * moves between members, so without this the refusal would be filed against
	 * a model that never saw the request. Read when the refusal arrives.
	 */
	readonly servedBy?: () => { readonly providerId: string; readonly model?: string }
	/** The retry without images was accepted: `refused` cannot read images. */
	readonly onAccepted: (refused: TextOnlyModelRefusal) => void | Promise<void>
}

/**
 * Retry one provider-invalid request without its only distinct image.
 *
 * The callback is the durable commit point for an HTTP 400 carrying the exact
 * provider code `invalid_image`. It runs only after the retry has produced an
 * accepted chunk or reached a clean EOF. A legacy phrase can still recover the
 * current request, but cannot assert durable server proof.
 */
export async function* streamWithProviderRejectedImageRecovery(
	provider: LLMProvider,
	params: ChatCompletionParams,
	onAccepted: (identity: RequestImageIdentity) => Promise<void>,
	onRequest?: (messages: readonly Message[]) => void,
	textOnly?: TextOnlyModelRecovery,
	repair?: RequestRepair,
): AsyncIterable<StreamChunk> {
	// Every send, including the retries below, goes through the request repair.
	const send = (request: ChatCompletionParams): AsyncIterable<StreamChunk> =>
		repair ? repair.stream(provider, request) : provider.chatStream(request)
	const candidate = findSingleRequestImage(params.messages)
	onRequest?.(params.messages)
	if (candidate === null && !requestHasImages(params.messages)) {
		yield* send(params)
		return
	}

	let produced = false
	let confidence: ImageRejectionConfidence | null = null
	let refused: TextOnlyModelRefusal | null = null
	try {
		for await (const chunk of send(params)) {
			if (isAcceptedChunk(chunk)) produced = true
			yield chunk
		}
		return
	} catch (error) {
		throwIfAborted(params.signal)
		if (produced) throw error
		// A fault in one image (the server's own `invalid_image`, or wording that
		// says an image could not be decoded) is about that image, not about the
		// model, and it wins: the model reads images, so it keeps the others.
		confidence = classifyProviderRejectedImageError(error)
		if (confidence === null && isImageInputRefusal(error)) {
			// A model that reads text only refuses the request however many images
			// it holds, so every image goes. Named now, while the member that
			// refused is still the one serving.
			const served = textOnly?.servedBy?.()
			refused = {
				providerId: served?.providerId ?? provider.id,
				model: served?.model ?? params.model,
			}
		} else if (confidence === null || candidate === null) {
			throw error
		}
	}

	throwIfAborted(params.signal)
	if (refused !== null) {
		// One retry, without any image. The stored conversation is untouched, so
		// a model that does read images gets them again.
		const messages = projectRequestRichContent(params.messages, 0, { imagesReadable: false })
		onRequest?.(messages)
		let accepted = false
		let reportedError = false
		for await (const chunk of send({ ...params, messages })) {
			if (chunk.error !== undefined) reportedError = true
			if (!accepted && isAcceptedChunk(chunk)) {
				throwIfAborted(params.signal)
				await textOnly?.onAccepted(refused)
				accepted = true
			}
			yield chunk
		}
		if (!accepted && !reportedError) await textOnly?.onAccepted(refused)
		return
	}
	if (candidate === null) return
	const retryParams: ChatCompletionParams = {
		...params,
		messages: projectRequestWithoutImage(params.messages, candidate),
	}
	let accepted = false
	let retryReportedError = false
	onRequest?.(retryParams.messages)
	for await (const chunk of send(retryParams)) {
		if (chunk.error !== undefined) retryReportedError = true
		if (!accepted && isAcceptedChunk(chunk)) {
			throwIfAborted(params.signal)
			if (confidence === 'server-confirmed') await onAccepted(candidate)
			accepted = true
		}
		yield chunk
	}
	if (!accepted && !retryReportedError) {
		throwIfAborted(params.signal)
		if (confidence === 'server-confirmed') await onAccepted(candidate)
	}
}
