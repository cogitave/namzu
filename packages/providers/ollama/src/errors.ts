import { ProviderRequestError, classifyHttpStatus, isProviderRequestError } from '@namzu/sdk'

const PROVIDER_ID = 'ollama'

/**
 * Socket/DNS/connection failures surfaced by Node's `fetch` (undici) when the
 * Ollama daemon is unreachable. A stopped local server is the common case this
 * turns from an opaque failure into a retryable `network` error — the primary
 * win of the taxonomy for a local runtime that rarely rate-limits.
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
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_SOCKET',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
])

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/**
 * Ollama's vendor `ResponseError` carries a numeric `status_code` but is not
 * exported from the `ollama` package, so it cannot be matched with `instanceof`.
 * Duck-type the field instead.
 */
function extractStatusCode(err: unknown): number | undefined {
	if (typeof err !== 'object' || err === null) return undefined
	const candidate = (err as { status_code?: unknown }).status_code
	return typeof candidate === 'number' ? candidate : undefined
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
	// Node's fetch reports connection failures as `TypeError: fetch failed`.
	return err instanceof TypeError && /fetch failed|network|socket|econnrefused/i.test(err.message)
}

/** Build an `aborted` error for a signal that fired before the request dispatched. */
export function abortedError(message: string): ProviderRequestError {
	return new ProviderRequestError(message, { kind: 'aborted', providerId: PROVIDER_ID })
}

/**
 * Normalize any error thrown by the `ollama` client (or by Node's transport)
 * into the SDK's uniform {@link ProviderRequestError}. The runtime retries only
 * `throttle | server | network`; everything else is terminal. Errors that are
 * already normalized pass through unchanged.
 */
export function toOllamaProviderError(err: unknown, signal?: AbortSignal): ProviderRequestError {
	if (isProviderRequestError(err)) return err

	const message = messageOf(err)

	if (isAbortError(err, signal)) {
		return new ProviderRequestError(message, {
			kind: 'aborted',
			providerId: PROVIDER_ID,
			cause: err,
		})
	}

	const status = extractStatusCode(err)
	if (status !== undefined) {
		return new ProviderRequestError(message, {
			kind: classifyHttpStatus(status),
			status,
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
