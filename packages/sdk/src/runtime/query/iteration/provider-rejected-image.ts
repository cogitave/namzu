import { isProviderRequestError } from '../../../provider/errors.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import {
	type RequestImageIdentity,
	findSingleRequestImage,
	projectRequestWithoutImage,
} from '../request-rich-content.js'

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
			chunk.replayState !== undefined,
	)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason
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
): AsyncIterable<StreamChunk> {
	const candidate = findSingleRequestImage(params.messages)
	if (candidate === null) {
		yield* provider.chatStream(params)
		return
	}

	let produced = false
	let confidence: ImageRejectionConfidence | null = null
	try {
		for await (const chunk of provider.chatStream(params)) {
			if (isAcceptedChunk(chunk)) produced = true
			yield chunk
		}
		return
	} catch (error) {
		throwIfAborted(params.signal)
		confidence = classifyProviderRejectedImageError(error)
		if (produced || confidence === null) throw error
	}

	throwIfAborted(params.signal)
	const retryParams: ChatCompletionParams = {
		...params,
		messages: projectRequestWithoutImage(params.messages, candidate),
	}
	let accepted = false
	let retryReportedError = false
	for await (const chunk of provider.chatStream(retryParams)) {
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
