/**
 * One classified error for every provider failure.
 *
 * Before this, a failure from any of the seven drivers reached the caller as an
 * opaque string, so nothing downstream could decide whether it was worth
 * retrying, whether it was the caller's fault, or whether the context window had
 * simply run out. Two drivers built that string by interpolating the response
 * body; three more inherited a vendor SDK error whose message IS the response
 * body. Either way, a credential the upstream echoed back landed in a message
 * that gets logged.
 *
 * So the contract here is deliberately narrow:
 *
 *  - the message is built from the STATUS LINE, the classified `kind`, and the
 *    provider's own complaint in `detail` — truncated and scrubbed of anything
 *    credential-shaped. The raw body is never re-thrown and never attached as
 *    `cause`; a `cause` survives every logger that serializes an error chain,
 *    which defeats the point.
 *
 *    The body used to be dropped entirely. That was over-corrected: a provider
 *    rejecting a request names the exact offending field, and deleting that
 *    sentence turned a one-line diagnosis into hypothesis elimination against a
 *    live API — once at the cost of a day of production downtime, while the
 *    wire had been saying `tools.0.custom.input_schema: … must match JSON
 *    Schema draft 2020-12` the entire time. Scrubbing what looks like a
 *    credential keeps the safety and returns the sentence.
 *  - `retryAfterMs` is DATA. Nothing in this module sleeps, backs off or
 *    retries. A retry loop inside a driver burns the run's wall clock and hides
 *    the failure from the layer that should decide.
 */

import type { ProviderErrorKind, ProviderRequestErrorInit } from '../types/provider/error.js'
export type {
	ProviderErrorInfo,
	ProviderErrorKind,
	ProviderRequestErrorInit,
} from '../types/provider/error.js'

const PROVIDER_ERROR_KINDS: readonly ProviderErrorKind[] = [
	'throttle',
	'network',
	'auth',
	'context_overflow',
	'bad_request',
	'server',
]

/**
 * A provider request that failed, classified.
 *
 * `name` is set explicitly rather than inherited, because the classifier is
 * matched structurally across a package boundary (a driver in one package throws
 * it; the runtime in another reads it) and `instanceof` is unreliable when two
 * copies of the SDK end up in one process.
 */
export class ProviderRequestError extends Error {
	public readonly kind: ProviderErrorKind
	public readonly providerId: string
	public readonly status?: number
	public readonly retryAfterMs?: number
	/**
	 * What the provider said was wrong, truncated and redacted.
	 *
	 * `ProviderRequestErrorInit` has declared this field all along and the
	 * constructor never read it, so every caller that set it was writing to
	 * nothing. That is not a cosmetic gap: a provider rejecting a request
	 * usually names the exact offending field, and losing that sentence turns
	 * a one-line diagnosis into hypothesis elimination against a live API. It
	 * did — a tool schema in the wrong JSON Schema dialect cost a day of
	 * production downtime while the wire had been saying
	 * `tools.0.custom.input_schema: … must match JSON Schema draft 2020-12`
	 * the whole time.
	 *
	 * See {@link vendorDetail} for what is kept and what is scrubbed.
	 */
	public readonly detail?: string

	constructor(init: ProviderRequestErrorInit) {
		super(buildProviderErrorMessage(init))
		this.name = 'ProviderRequestError'
		this.kind = init.kind
		this.providerId = init.providerId
		if (init.status !== undefined) this.status = init.status
		if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs
		if (init.detail !== undefined) this.detail = init.detail
	}
}

/** Longest detail worth carrying. A provider's complaint is a sentence. */
const DETAIL_MAX = 400

/**
 * Credential shapes to scrub before a provider's words are kept.
 *
 * The original decision to discard the body outright was not paranoia — an
 * error body can echo the request, and a request can carry a key. The answer
 * is to scrub what looks like a credential rather than to throw away the
 * sentence that names the broken field.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}/g,
	/\bnpm_[A-Za-z0-9]{20,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/("(?:api[_-]?key|authorization|token|secret|password)"\s*:\s*)"[^"]*"/gi,
]

/**
 * The provider's own account of what was wrong, safe to log.
 *
 * Prefers the structured `error.message` a JSON body carries, because that is
 * the field vendors put the actionable sentence in and it is bounded; falls
 * back to the raw text. Truncated, and every credential shape replaced.
 */
export function vendorDetail(body: unknown): string | undefined {
	if (body === undefined || body === null) return undefined

	let text: string
	if (typeof body === 'string') {
		try {
			text = pickMessage(JSON.parse(body)) ?? body
		} catch {
			text = body
		}
	} else {
		text = pickMessage(body) ?? ''
	}

	const cleaned = redactSecrets(text.trim())
	if (cleaned.length === 0) return undefined
	return cleaned.length > DETAIL_MAX ? `${cleaned.slice(0, DETAIL_MAX)}…` : cleaned
}

export function redactSecrets(text: string): string {
	let out = text
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, (_match, prefix?: string) =>
			prefix === undefined ? '[redacted]' : `${prefix}"[redacted]"`,
		)
	}
	return out
}

function pickMessage(value: unknown): string | undefined {
	if (typeof value === 'string') return value
	if (typeof value !== 'object' || value === null) return undefined
	const node = value as Record<string, unknown>
	// `{ error: { message } }` is what every wire in this tree uses; the rest
	// are the shapes seen in the drivers' own fixtures.
	const nested = node.error
	if (typeof nested === 'string') return nested
	if (typeof nested === 'object' && nested !== null) {
		const message = (nested as Record<string, unknown>).message
		if (typeof message === 'string') return message
	}
	if (typeof node.message === 'string') return node.message
	return undefined
}

/** Is this a classified provider failure, whichever SDK copy threw it? */
export function isProviderRequestError(err: unknown): err is ProviderRequestError {
	return (
		err instanceof Error &&
		err.name === 'ProviderRequestError' &&
		typeof (err as { providerId?: unknown }).providerId === 'string' &&
		PROVIDER_ERROR_KINDS.includes((err as { kind?: ProviderErrorKind }).kind as ProviderErrorKind)
	)
}

/**
 * Did the caller's own AbortSignal terminate this request?
 *
 * Provider SDKs do not agree on the object they reject with: some preserve
 * `signal.reason`, while others replace it with `AbortError` or
 * `APIUserAbortError`. Reclassifying any of those as a network failure breaks
 * the runtime's Stop/cancel path, which depends on the abort escaping the
 * provider boundary.
 *
 * The signal must itself be aborted. That condition distinguishes a caller Stop
 * from an SDK timeout which may also use an `AbortError`-shaped rejection.
 */
export function isCallerAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (!signal?.aborted) return false
	if (error === signal.reason) return true
	if (!(error instanceof Error)) return false
	return error.name === 'AbortError' || error.name === 'APIUserAbortError'
}

const KIND_SENTENCE: Record<ProviderErrorKind, string> = {
	throttle: 'rate limited by the provider',
	network: 'could not reach the provider',
	auth: 'the provider rejected the request credentials',
	context_overflow: 'the request exceeded the model context window',
	bad_request: 'the provider rejected the request as invalid',
	server: 'the provider failed to complete the request',
}

function buildProviderErrorMessage(init: ProviderRequestErrorInit): string {
	const status = init.status !== undefined ? ` (HTTP ${init.status})` : ''
	const detail = init.detail ? `: ${init.detail}` : ''
	return `${init.providerId}${status} — ${KIND_SENTENCE[init.kind]}${detail}`
}

/**
 * Body fragments that mean "the request did not fit", across the vendors we
 * drive. Matched case-insensitively against the raw body, which is then
 * discarded.
 *
 * A 400 is otherwise `bad_request`: an overflow is the one 400 a caller can act
 * on automatically (compact and retry), and mistaking a genuine schema error for
 * an overflow would send the run into a pointless compaction loop.
 */
const OVERFLOW_BODY_PATTERNS: readonly RegExp[] = [
	/prompt is too long/i,
	/context[_ ]length[_ ]exceeded/i,
	/maximum context length/i,
	/too long for requested model/i,
	/input is too long/i,
	/(?:input|prompt|context).{0,80}exceeds the maximum/i,
	/reduce the (?:input|prompt|context) length/i,
	// Ollama phrases it the other way round — "input length exceeds context
	// length" — so a pattern anchored on "exceeded" misses it entirely.
	/exceeds?\s+(?:the\s+)?(?:model'?s?\s+)?context\s+(?:length|window|size)/i,
	/context\s+(?:length|window|size)\s+exceed/i,
]

/** Does this response body say the request did not fit the window? */
export function bodySaysContextOverflow(body: string | undefined | null): boolean {
	if (!body) return false
	return OVERFLOW_BODY_PATTERNS.some((re) => re.test(body))
}

/**
 * `Retry-After` in milliseconds. The header is either delta-seconds or an
 * HTTP-date; both are specified, and vendors use both.
 *
 * Returns undefined for anything unparseable or for a date already in the past —
 * a negative delay is worse than none, because a caller would treat it as
 * "retry immediately" against a provider that just asked it to wait.
 */
export function parseRetryAfterMs(
	headerValue: string | null | undefined,
	now: number = Date.now(),
): number | undefined {
	if (!headerValue) return undefined
	const trimmed = headerValue.trim()
	if (trimmed === '') return undefined

	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		const seconds = Number(trimmed)
		if (!Number.isFinite(seconds) || seconds < 0) return undefined
		return Math.round(seconds * 1000)
	}

	const at = Date.parse(trimmed)
	if (Number.isNaN(at)) return undefined
	const delta = at - now
	return delta > 0 ? delta : undefined
}

/**
 * Classify an HTTP failure. `body` is used ONLY to separate a context overflow
 * from an ordinary bad request, and is not retained.
 */
export function classifyProviderHttpStatus(
	status: number,
	body?: string | null,
): ProviderErrorKind {
	if (status === 401 || status === 403) return 'auth'
	if (status === 429) return 'throttle'
	if (status === 408 || status === 425) return 'network'
	if (status >= 500) return 'server'
	if (status === 413) {
		return bodySaysContextOverflow(body) ? 'context_overflow' : 'bad_request'
	}
	if (status >= 400) {
		return bodySaysContextOverflow(body) ? 'context_overflow' : 'bad_request'
	}
	// A non-failure status reaching here is a caller bug, not a provider one.
	return 'server'
}

/**
 * Vendor error TYPES, as the vendors name them in their own payloads. This is a
 * defined vocabulary, not prose, which is what makes it safe to classify on:
 * Anthropic sends `{"error":{"type":"overloaded_error"}}` and OpenAI sends
 * `{"error":{"code":"context_length_exceeded"}}`.
 *
 * It matters for MID-STREAM failures above all. Those arrive after a 200, so
 * there is no status to classify from, and without this an upstream overload
 * would be filed as `network` — "we could not reach the provider" — when the
 * provider answered and then gave up. The distinction is the whole point of the
 * taxonomy: one is worth retrying elsewhere, the other is worth retrying here.
 */
const VENDOR_TYPE_KINDS: ReadonlyArray<readonly [RegExp, ProviderErrorKind]> = [
	[/overloaded_error|api_error|service_unavailable/i, 'server'],
	[/rate_limit_error|rate_limit_exceeded/i, 'throttle'],
	[/authentication_error|permission_error|invalid_api_key|unauthorized/i, 'auth'],
	[/timeout_error|connection_error/i, 'network'],
]

/** The kind a vendor's own error-type vocabulary implies, if it says one. */
function vendorTypeKind(message: string): ProviderErrorKind | undefined {
	for (const [re, kind] of VENDOR_TYPE_KINDS) {
		if (re.test(message)) return kind
	}
	return undefined
}

/**
 * Status code off a vendor SDK's own error object, whatever it calls the field.
 * Anthropic and OpenAI use `status`; the ollama client uses `status_code`; AWS
 * puts it under `$metadata.httpStatusCode`.
 */
function vendorErrorStatus(err: unknown): number | undefined {
	if (typeof err !== 'object' || err === null) return undefined
	const e = err as {
		status?: unknown
		statusCode?: unknown
		status_code?: unknown
		$metadata?: { httpStatusCode?: unknown }
	}
	for (const candidate of [e.status, e.statusCode, e.status_code, e.$metadata?.httpStatusCode]) {
		if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
	}
	return undefined
}

/**
 * `retry-after` off a vendor SDK error's captured response headers. The
 * Anthropic and OpenAI clients both attach them (as a `Headers` instance or a
 * plain object depending on version); the ollama client throws them away, which
 * is why `retryAfterMs` is genuinely unavailable on that driver.
 */
function vendorRetryAfter(err: unknown): string | undefined {
	if (typeof err !== 'object' || err === null) return undefined
	// AWS keeps the response one level down, on `$response`; the Anthropic and
	// OpenAI clients attach `headers` directly.
	const headers =
		(err as { headers?: unknown }).headers ??
		(err as { $response?: { headers?: unknown } }).$response?.headers
	if (!headers) return undefined
	if (typeof (headers as Headers).get === 'function') {
		return (headers as Headers).get('retry-after') ?? undefined
	}
	const record = headers as Record<string, unknown>
	for (const key of ['retry-after', 'Retry-After', 'retryAfter']) {
		const value = record[key]
		if (typeof value === 'string') return value
	}
	return undefined
}

/**
 * Classify an error thrown by a vendor SDK and replace it.
 *
 * This exists because wrapping our OWN `!response.ok` throws is not enough. The
 * Anthropic, OpenAI and ollama clients each build their error message FROM the
 * response body, so a credential the upstream echoed back is already inside
 * `err.message` before our code sees it. Proven with a planted fake token on all
 * three.
 *
 * So the vendor error is read for its status and scanned for an overflow
 * signature, and then **dropped entirely** — not re-thrown, not wrapped, and not
 * attached as `cause`. A `cause` is exactly what a structured logger walks, so
 * keeping one for debuggability would reintroduce the leak it is meant to close.
 *
 * `name` is checked too, because AWS models its failures as distinct classes
 * (`ThrottlingException`, `ValidationException`, `AccessDeniedException`) rather
 * than as status codes.
 */
export function providerVendorError(input: {
	readonly providerId: string
	readonly error: unknown
	readonly retryAfter?: string | null
	readonly now?: number
}): ProviderRequestError {
	const { error } = input
	const status = vendorErrorStatus(error)
	const name = error instanceof Error ? error.name : ''
	const message = error instanceof Error ? error.message : ''

	let kind: ProviderErrorKind
	if (/ThrottlingException|TooManyRequests|ServiceQuotaExceeded/i.test(name)) {
		kind = 'throttle'
	} else if (/AccessDenied|Unauthorized|Forbidden|Authentication/i.test(name)) {
		kind = 'auth'
	} else if (/ValidationException/i.test(name)) {
		kind = bodySaysContextOverflow(message) ? 'context_overflow' : 'bad_request'
	} else if (
		/ServiceUnavailable|InternalServer|ModelTimeout|ModelStreamError|ModelError|ModelNotReady/i.test(
			name,
		)
	) {
		kind = 'server'
	} else if (status !== undefined) {
		kind = classifyProviderHttpStatus(status, message)
	} else if (bodySaysContextOverflow(message)) {
		kind = 'context_overflow'
	} else {
		// No status: a mid-stream failure, or a transport error. The vendor's own
		// error-type vocabulary is the only signal left; absent that, the request
		// genuinely did not get an answer.
		kind = vendorTypeKind(message) ?? 'network'
	}

	const retryAfterMs = parseRetryAfterMs(
		input.retryAfter ?? vendorRetryAfter(error),
		input.now ?? Date.now(),
	)
	const detail = vendorDetail(message)
	return new ProviderRequestError({
		kind,
		providerId: input.providerId,
		...(status !== undefined ? { status } : {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		...(detail !== undefined ? { detail } : {}),
	})
}

/**
 * Build a classified error from a failed HTTP response.
 *
 * Callers pass the body they already read for classification; this function
 * does not return it, store it, or put it in the message.
 */
export function providerHttpError(input: {
	readonly providerId: string
	readonly status: number
	readonly body?: string | null
	readonly retryAfter?: string | null
	readonly now?: number
}): ProviderRequestError {
	const kind = classifyProviderHttpStatus(input.status, input.body)
	const retryAfterMs = parseRetryAfterMs(input.retryAfter, input.now ?? Date.now())
	const detail = vendorDetail(input.body)
	return new ProviderRequestError({
		kind,
		providerId: input.providerId,
		status: input.status,
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		...(detail !== undefined ? { detail } : {}),
	})
}
