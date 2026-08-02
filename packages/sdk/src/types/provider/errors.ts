/**
 * Provider failure taxonomy.
 *
 * Every driver throws whatever its underlying vendor SDK threw, which
 * means the runtime cannot tell a 429 from a malformed request from a
 * dead socket — and therefore cannot decide whether to back off, fail
 * fast, or compact and retry. Classification is the substrate the retry
 * policy stands on; without it "add a retry" is unimplementable.
 *
 * The union is deliberately small. It answers exactly three questions the
 * runtime asks: is it worth retrying, should the delay come from the
 * server, and is this a context problem the run could recover from by
 * shedding history.
 */
export type ProviderErrorCode =
	/** 429. Back off; honour `retryAfterMs` when the server sent one. */
	| 'rate_limit'
	/** 529 / 503 — the model is up but saturated. Back off. */
	| 'overloaded'
	/** Any other 5xx. Back off. */
	| 'server_error'
	/** The request timed out in transit. Retry. */
	| 'timeout'
	/** Socket/DNS/TLS failure before a response. Retry. */
	| 'network'
	/** 401 / 403. A retry cannot help. */
	| 'auth'
	/** 400 and friends. A retry cannot help. */
	| 'invalid_request'
	/** The prompt exceeds the model window. Retrying verbatim cannot help. */
	| 'context_length_exceeded'
	/** The provider refused on safety grounds. */
	| 'content_filter'
	/** 404 — unknown model or endpoint. */
	| 'not_found'
	/** Unclassifiable. Treated as non-retryable. */
	| 'unknown'

export interface ProviderErrorInit {
	readonly code: ProviderErrorCode
	readonly message: string
	readonly providerId?: string
	readonly status?: number
	/** Server-directed backoff, derived from a `Retry-After` header. */
	readonly retryAfterMs?: number
	readonly cause?: unknown
}

/** Codes for which sending the identical request again may succeed. */
const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
	'rate_limit',
	'overloaded',
	'server_error',
	'timeout',
	'network',
])

export class ProviderError extends Error {
	readonly code: ProviderErrorCode
	readonly providerId: string | undefined
	readonly status: number | undefined
	readonly retryAfterMs: number | undefined
	readonly retryable: boolean

	constructor(init: ProviderErrorInit) {
		super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined)
		this.name = 'ProviderError'
		this.code = init.code
		this.providerId = init.providerId
		this.status = init.status
		this.retryAfterMs = init.retryAfterMs
		this.retryable = RETRYABLE.has(init.code)
	}
}

export function isProviderError(err: unknown): err is ProviderError {
	return err instanceof ProviderError
}

/**
 * An abort is a control-flow signal, not a provider failure: the run loop
 * settles it as `cancelled`. It must never be reclassified or retried.
 */
export function isAbortError(err: unknown): boolean {
	if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
		return true
	}
	// DOMException-shaped aborts from fetch, and raw `signal.reason` values.
	const name = (err as { name?: unknown } | null)?.name
	return name === 'AbortError'
}

/**
 * Every throwable on the cause chain, outermost first.
 *
 * A signal was only ever read off the error handed in, so one layer of
 * wrapping hid it — and wrapping is the normal case, not an edge one:
 * vendor SDKs wrap their transport errors and the runtime wraps again on
 * the way out. A rate limit wrapped once classified as `unknown`, which is
 * treated as non-retryable, so the retry policy was dead for every failure
 * that was not the outermost throwable.
 *
 * The `seen` set is not defensive decoration: a cause cycle is easy to
 * build by accident when errors are re-wrapped in a retry loop, and
 * without it this walk never terminates.
 */
function* causeChain(err: unknown): Generator<Record<string, unknown>> {
	const seen = new Set<unknown>()
	let current: unknown = err
	while (current !== null && typeof current === 'object' && !seen.has(current)) {
		seen.add(current)
		yield current as Record<string, unknown>
		current = (current as { cause?: unknown }).cause
	}
}

function readStatus(err: unknown): number | undefined {
	for (const link of causeChain(err)) {
		const e = link as {
			status?: unknown
			statusCode?: unknown
			response?: { status?: unknown }
			// Some vendor SDKs hide the status in a metadata bag rather than
			// on the error itself. It is still a status; not looking there
			// meant a throttle fell through to message-text matching and,
			// when the wording did not happen to match, was filed as
			// `unknown` and never retried.
			$metadata?: { httpStatusCode?: unknown }
		}
		for (const candidate of [
			e.status,
			e.statusCode,
			e.response?.status,
			e.$metadata?.httpStatusCode,
		]) {
			if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
		}
	}
	return undefined
}

/**
 * `Retry-After` is either delta-seconds or an HTTP date. Both appear in
 * the wild; most providers send seconds.
 */
function readRetryAfterMs(err: unknown, now: number): number | undefined {
	for (const link of causeChain(err)) {
		const headers = link.headers
		if (!headers) continue

		let raw: string | undefined
		if (typeof (headers as Headers).get === 'function') {
			raw = (headers as Headers).get('retry-after') ?? undefined
		} else if (typeof headers === 'object') {
			const bag = headers as Record<string, unknown>
			const value = bag['retry-after'] ?? bag['Retry-After']
			if (typeof value === 'string' || typeof value === 'number') raw = String(value)
		}
		if (raw === undefined) continue

		const seconds = Number(raw)
		if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)

		const at = Date.parse(raw)
		if (Number.isFinite(at)) return Math.max(0, at - now)
	}
	return undefined
}

function readErrnoCode(err: unknown): string | undefined {
	// The whole chain, not one level down. A transport failure is usually
	// the innermost link and everything above it is context, so stopping at
	// depth one meant a socket reset behind two wrappers read as unknown —
	// which is non-retryable, for the one class of failure where retrying
	// is almost always right.
	for (const link of causeChain(err)) {
		if (typeof link.code === 'string') return link.code
	}
	return undefined
}

/** Every message on the chain, outermost first. */
function chainMessages(err: unknown): string[] {
	const out: string[] = []
	for (const link of causeChain(err)) {
		if (typeof link.message === 'string' && link.message.length > 0) out.push(link.message)
	}
	return out
}

/** Node/undici transport failures that mean "never reached the model". */
const NETWORK_ERRNOS: ReadonlySet<string> = new Set([
	'ECONNRESET',
	'ECONNREFUSED',
	'ECONNABORTED',
	'EPIPE',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ENOTFOUND',
	'EAI_AGAIN',
	'EPROTO',
	'UND_ERR_SOCKET',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_RESPONSE_STATUS_CODE',
])

const TIMEOUT_ERRNOS: ReadonlySet<string> = new Set([
	'ETIMEDOUT',
	'ESOCKETTIMEDOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
])

function codeFromStatus(status: number): ProviderErrorCode {
	if (status === 429) return 'rate_limit'
	if (status === 401 || status === 403) return 'auth'
	if (status === 404) return 'not_found'
	if (status === 408) return 'timeout'
	if (status === 529 || status === 503) return 'overloaded'
	if (status >= 500) return 'server_error'
	if (status >= 400) return 'invalid_request'
	return 'unknown'
}

/**
 * Message sniffing is the LAST resort, used only when there is no status
 * and no errno. Vendors that tunnel a 400 through a 200 body (several
 * gateways do) are only reachable this way.
 */
function codeFromMessage(message: string): ProviderErrorCode | undefined {
	const m = message.toLowerCase()
	if (
		m.includes('context length') ||
		m.includes('context_length') ||
		m.includes('maximum context') ||
		m.includes('too many tokens') ||
		m.includes('prompt is too long')
	) {
		return 'context_length_exceeded'
	}
	if (m.includes('rate limit') || m.includes('rate_limit') || m.includes('too many requests')) {
		return 'rate_limit'
	}
	if (m.includes('overloaded')) return 'overloaded'
	if (
		m.includes('content filter') ||
		m.includes('content_filter') ||
		m.includes('content policy')
	) {
		return 'content_filter'
	}
	if (m.includes('timed out') || m.includes('timeout')) return 'timeout'
	if (m.includes('unauthorized') || m.includes('invalid api key') || m.includes('authentication')) {
		return 'auth'
	}
	return undefined
}

/**
 * Turn whatever a driver threw into a {@link ProviderError}.
 *
 * Precedence is deliberate: HTTP status is the most reliable signal, then
 * transport errno, then message text. `context_length_exceeded` is checked
 * ahead of the generic 400 mapping because it is the one 4xx the runtime
 * can actually act on (shed history and retry) rather than surface.
 *
 * Every signal is read across the WHOLE cause chain, not off the error
 * handed in. Wrapping is the normal case — a vendor SDK wraps its
 * transport error and the runtime wraps again on the way out — and reading
 * only the outer link meant a rate limit wrapped once classified as
 * `unknown`, which is non-retryable. The retry policy was therefore dead
 * for every failure that was not the outermost throwable.
 *
 * Aborts are passed through untouched — see {@link isAbortError}.
 */
export function classifyProviderError(
	err: unknown,
	providerId?: string,
	now: number = Date.now(),
): ProviderError {
	if (isProviderError(err)) return err

	const message = err instanceof Error ? err.message : String(err)
	const status = readStatus(err)
	const errno = readErrnoCode(err)
	const retryAfterMs = readRetryAfterMs(err, now)

	// Message sniffing also reads the chain. The wording that identifies a
	// failure sits on the link that produced it, and a wrapper's message is
	// usually generic ("request failed") — so matching only the outer text
	// looks at the one string least likely to say anything.
	const messages = chainMessages(err)
	const fromMessage = messages.map(codeFromMessage).find((code) => code !== undefined)

	// A 400 that is really a window overflow must not be filed as a plain
	// invalid_request: the caller can recover from one and not the other.
	if (messages.some((m) => codeFromMessage(m) === 'context_length_exceeded')) {
		return new ProviderError({
			code: 'context_length_exceeded',
			message,
			providerId,
			status,
			cause: err,
		})
	}

	if (status !== undefined) {
		return new ProviderError({
			code: codeFromStatus(status),
			message,
			providerId,
			status,
			retryAfterMs,
			cause: err,
		})
	}

	if (errno !== undefined) {
		if (TIMEOUT_ERRNOS.has(errno)) {
			return new ProviderError({ code: 'timeout', message, providerId, cause: err })
		}
		if (NETWORK_ERRNOS.has(errno)) {
			return new ProviderError({ code: 'network', message, providerId, cause: err })
		}
	}

	// `fetch` rejects with a bare TypeError on transport failure.
	if (err instanceof TypeError && /fetch|network/i.test(message)) {
		return new ProviderError({ code: 'network', message, providerId, cause: err })
	}

	return new ProviderError({
		code: fromMessage ?? 'unknown',
		message,
		providerId,
		retryAfterMs,
		cause: err,
	})
}
