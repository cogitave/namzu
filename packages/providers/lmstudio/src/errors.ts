import { ProviderRequestError, isProviderRequestError } from '@namzu/sdk'

const PROVIDER_ID = 'lmstudio'

/**
 * Socket/connection failures. LM Studio's SDK talks WebSocket to a local server,
 * so a stopped server surfaces either a Node socket error (`ECONNREFUSED`) or a
 * "Failed to connect to LM Studio" pretty-error from the transport. Mapping both
 * to a retryable `network` error is the primary win for a local runtime that
 * rarely rate-limits.
 */
const NETWORK_ERROR_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ECONNABORTED',
	'ETIMEDOUT',
	'ENOTFOUND',
	'EAI_AGAIN',
	'EHOSTUNREACH',
	'EHOSTDOWN',
	'ENETUNREACH',
	'EPIPE',
])

/**
 * Substrings the LM Studio SDK bakes into its transport errors when the server
 * is unreachable. The messages carry ANSI color codes but the inner phrases are
 * contiguous, so a case-insensitive substring test survives them.
 */
const NETWORK_MESSAGE_RE =
	/failed to connect|connect to lm studio|econnrefused|websocket|not connected|connection refused|disconnected/i

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true
	return err instanceof Error && err.name === 'AbortError'
}

/** Walk `cause` and `AggregateError.errors` chains collecting any `.code` values. */
function collectCodes(err: unknown, depth = 0, acc: string[] = []): string[] {
	if (depth > 4 || typeof err !== 'object' || err === null) return acc
	const code = (err as { code?: unknown }).code
	if (typeof code === 'string') acc.push(code)
	const cause = (err as { cause?: unknown }).cause
	if (cause !== undefined) collectCodes(cause, depth + 1, acc)
	const errors = (err as { errors?: unknown }).errors
	if (Array.isArray(errors)) for (const sub of errors) collectCodes(sub, depth + 1, acc)
	return acc
}

function isNetworkError(err: unknown): boolean {
	if (collectCodes(err).some((c) => NETWORK_ERROR_CODES.has(c))) return true
	return err instanceof Error && NETWORK_MESSAGE_RE.test(err.message)
}

/** Build an `aborted` error for a signal that fired before the request dispatched. */
export function abortedError(message: string): ProviderRequestError {
	return new ProviderRequestError(message, { kind: 'aborted', providerId: PROVIDER_ID })
}

/**
 * Build a `context_overflow` error. LM Studio reports context exhaustion as a
 * *successful* prediction (stopReason `contextLengthReached`), so the client
 * detects the input-overflow case and calls this explicitly.
 */
export function contextOverflowError(message: string): ProviderRequestError {
	return new ProviderRequestError(message, { kind: 'context_overflow', providerId: PROVIDER_ID })
}

/**
 * Normalize any error thrown by the `@lmstudio/sdk` client into the SDK's uniform
 * {@link ProviderRequestError}. The runtime retries only `throttle | server |
 * network`; everything else is terminal. The WebSocket transport exposes no HTTP
 * status, so classification is abort-vs-network-vs-unknown. Already-normalized
 * errors (e.g. the context-overflow throw) pass through unchanged.
 */
export function toLMStudioProviderError(err: unknown, signal?: AbortSignal): ProviderRequestError {
	if (isProviderRequestError(err)) return err

	const message = messageOf(err)

	if (isAbortError(err, signal)) {
		return new ProviderRequestError(message, {
			kind: 'aborted',
			providerId: PROVIDER_ID,
			cause: err,
		})
	}

	if (isNetworkError(err)) {
		return new ProviderRequestError(message, {
			kind: 'network',
			providerId: PROVIDER_ID,
			cause: err,
		})
	}

	return new ProviderRequestError(message, { kind: 'unknown', providerId: PROVIDER_ID, cause: err })
}
