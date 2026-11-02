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
 *    retries. A retry loop inside a driver burns the turn's wall clock and hides
 *    the failure from the layer that should decide.
 */

import { LOG_SECRET_PATTERNS } from '../constants/secret-patterns.js'
import type { ProviderErrorKind, ProviderRequestErrorInit } from '../types/provider/error.js'
import {
	type TransportCause,
	isUsageLimitSignal,
	readCertificateFailure,
	readTransportCause,
} from '../types/provider/errors.js'
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
	public readonly providerCode?: string
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
	/** The provider's `x-should-retry` verdict, when it sent one; see {@link ProviderRequestErrorInit.shouldRetry}. */
	public readonly shouldRetry?: boolean
	/** The part of the network path the request tripped on, when known; see {@link ProviderRequestErrorInit.transport}. */
	public readonly transport?: TransportCause

	constructor(init: ProviderRequestErrorInit) {
		super(buildProviderErrorMessage(init))
		this.name = 'ProviderRequestError'
		this.kind = init.kind
		this.providerId = init.providerId
		const exactProviderCode = safeProviderCode(init.providerCode)
		if (exactProviderCode !== undefined) this.providerCode = exactProviderCode
		if (init.status !== undefined) this.status = init.status
		if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs
		if (init.detail !== undefined) this.detail = init.detail
		if (init.shouldRetry !== undefined) this.shouldRetry = init.shouldRetry
		if (init.transport !== undefined) this.transport = init.transport
	}
}

/** Longest detail worth carrying. A provider's complaint is a sentence. */
const DETAIL_MAX = 400

/** Provider codes are identifiers, not another channel for an arbitrary response body. */
const PROVIDER_CODE = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/

function safeProviderCode(value: unknown): string | undefined {
	if (typeof value !== 'string' || !PROVIDER_CODE.test(value)) return undefined
	return redactSecrets(value) === value ? value : undefined
}

function providerCode(value: unknown): string | undefined {
	let decoded = value
	if (typeof decoded === 'string') {
		try {
			decoded = JSON.parse(decoded)
		} catch {
			return undefined
		}
	}
	if (typeof decoded !== 'object' || decoded === null) return undefined
	const record = decoded as Record<string, unknown>
	const nested =
		typeof record.error === 'object' && record.error !== null
			? (record.error as Record<string, unknown>).code
			: undefined
	return safeProviderCode(record.code ?? nested)
}

/**
 * A vendor can name a spent allowance in `type` instead of `code`
 * (`{"error":{"type":"usage_limit_reached"}}`, `{"error":{"type":"billing_error"}}`).
 * Only those identifiers are lifted to a provider code; any other `type` is a
 * category and stays where it was.
 */
function usageLimitTypeOf(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined
	const outer = error as { type?: unknown; error?: unknown }
	const inner =
		typeof outer.error === 'object' && outer.error !== null
			? (outer.error as { type?: unknown; error?: unknown })
			: undefined
	const innermost =
		typeof inner?.error === 'object' && inner.error !== null
			? (inner.error as { type?: unknown })
			: undefined
	for (const candidate of [outer.type, inner?.type, innermost?.type]) {
		if (typeof candidate === 'string' && isUsageLimitSignal(candidate, undefined)) {
			return safeProviderCode(candidate)
		}
	}
	return undefined
}

/**
 * Credential shapes to scrub before a provider's words are kept.
 *
 * The original decision to discard the body outright was not paranoia — an
 * error body can echo the request, and a request can carry a key. The answer
 * is to scrub what looks like a credential rather than to throw away the
 * sentence that names the broken field.
 *
 * The pattern set itself now lives in `constants/secret-patterns.ts`, as
 * `LOG_SECRET_PATTERNS` — the union of this table and the narrower one
 * `runtime/query/guardrail-presets.ts` matches model OUTPUT against. A
 * false positive here only redacts a word out of a diagnostic `detail`
 * nobody reads as the credential itself, which is why this call site gets
 * the wider set and the output guardrail does not.
 */

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
	for (const [label, pattern] of LOG_SECRET_PATTERNS) {
		// Whole match replaced with the label, never the matched text — same
		// convention `secretRedactionGuardrail` already uses, so a `[REDACTED:…]`
		// marker means the same thing wherever it is read.
		out = out.replace(pattern, `[REDACTED:${label}]`)
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
	const exactProviderCode = (err as { providerCode?: unknown } | null)?.providerCode
	return (
		err instanceof Error &&
		err.name === 'ProviderRequestError' &&
		typeof (err as { providerId?: unknown }).providerId === 'string' &&
		PROVIDER_ERROR_KINDS.includes(
			(err as { kind?: ProviderErrorKind }).kind as ProviderErrorKind,
		) &&
		(exactProviderCode === undefined || safeProviderCode(exactProviderCode) === exactProviderCode)
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
 * an overflow would send the turn into a pointless compaction loop.
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
	// The bare phrase "context
	// window" is too broad on its own. Here it must sit next to a verb that says the request did not
	// fit ("larger than the model context window of N tokens"), so a 400 that
	// only names the window ("does not support this parameter with the 1M
	// context window beta") stays an invalid request. The same pattern lives in
	// `types/provider/errors.ts` (`codeFromMessage`), which also gates it on the
	// status; keep them equal.
	/(?:exceed\w*|too (?:long|large|big)|larger than|longer than|over the|beyond|maximum|overflow\w*)\b[^.]{0,60}context window|context window[^.]{0,60}\b(?:exceed\w*|too (?:long|large|big)|larger than|longer than|over the|beyond|maximum|overflow\w*)/i,
	// "input length and `max_tokens` exceed context limit: A + B > C". The
	// prompt may fit and only the requested output not; the loop tries a smaller
	// `max_tokens` first (readOutputOverflow) and falls back to shedding history
	// when there is no room for a useful reply, which needs this to classify.
	/input length and `?max_tokens`? exceed context limit/i,
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
/**
 * `x-should-retry` is only read when it says `false`: that is the provider
 * refusing a resend, and it outranks the status code. `true` changes nothing,
 * because a retryable status is already retried.
 */
export function parseShouldRetry(value: string | null | undefined): false | undefined {
	return value?.trim().toLowerCase() === 'false' ? false : undefined
}

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

/** Response headers that name the request, as the vendors that send one spell it. */
const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'x-goog-request-id'] as const

/** A header off an SDK error's captured response headers (a `Headers` or a plain object). */
function vendorHeader(err: unknown, names: readonly string[]): string | undefined {
	if (typeof err !== 'object' || err === null) return undefined
	const headers =
		(err as { headers?: unknown }).headers ??
		(err as { $response?: { headers?: unknown } }).$response?.headers
	if (!headers) return undefined
	for (const name of names) {
		if (typeof (headers as Headers).get === 'function') {
			const value = (headers as Headers).get(name)
			if (value) return value
			continue
		}
		const value = (headers as Record<string, unknown>)[name]
		if (typeof value === 'string' && value) return value
	}
	return undefined
}

const FIELD_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/

function fieldValue(value: unknown): string | undefined {
	return typeof value === 'string' && FIELD_VALUE.test(value) && redactSecrets(value) === value
		? value
		: undefined
}

/**
 * The provider's structured fields beside its sentence, in the one body shape every host already
 * reads (`{"error":{"message","type","code","param"},"request_id"}`).
 *
 * A vendor SDK whose error message is only the parsed sentence (OpenAI's "403 <message>") still
 * holds the body's `type`, `code`, `param` and the response's request ID as fields; a host that
 * receives the message alone cannot show them, while Anthropic's message carries its whole body
 * and so shows them. The fields are bounded identifiers (never a body), so nothing echoed can ride
 * along. With nothing but a sentence the result is that sentence unchanged.
 */
export function structuredVendorDetail(input: {
	readonly message: string | undefined
	readonly type?: unknown
	readonly code?: unknown
	readonly param?: unknown
	readonly requestId?: unknown
}): string | undefined {
	const message = vendorDetail(input.message?.replace(/^\d{3}\s+/, ''))
	const type = fieldValue(input.type)
	const code = fieldValue(input.code)
	const param = fieldValue(input.param)
	const requestId = fieldValue(input.requestId)
	if (!type && !code && !param && !requestId) return message
	if (!message) return undefined
	return JSON.stringify({
		error: {
			message,
			...(type ? { type } : {}),
			...(code ? { code } : {}),
			...(param ? { param } : {}),
		},
		...(requestId ? { request_id: requestId } : {}),
	})
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
 * `utils/log/exception.ts` now walks a `cause` chain for whatever DOES carry
 * one, to put `exception.stacktrace` in a log record instead of just the
 * caught error's own message. That mapper existing is not a reason to start
 * attaching one here: every one of the six drivers in `packages/providers/*`
 * (openai, anthropic, ollama, bedrock, openrouter, lmstudio) throws through
 * this function specifically because none of them can otherwise avoid
 * handing a structured logger the credential a vendor SDK just echoed back.
 * Each driver's own `error-taxonomy.test.ts` asserts `'cause' in (err as
 * object)` is `false` on ITS OWN thrown error, not just on this function in
 * isolation — that is what would catch a driver that stops going through
 * `providerVendorError`/`providerHttpError` and attaches one directly.
 * `packages/sdk/src/provider/__tests__/errors.test.ts` pins the same thing
 * against this shared function directly. See "index".
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
	const exactProviderCode = providerCode(error) ?? usageLimitTypeOf(error)
	const name = error instanceof Error ? error.name : ''
	const message = error instanceof Error ? error.message : ''

	// A proxy that refuses the tunnel or a certificate nobody trusts has no status
	// to read, and the same request meets the same obstacle again.
	const transport = readTransportCause(error)

	let kind: ProviderErrorKind
	if (transport !== undefined) {
		kind = 'network'
	} else if (/ThrottlingException|TooManyRequests|ServiceQuotaExceeded/i.test(name)) {
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
	} else if (exactProviderCode === 'invalid_image') {
		kind = 'bad_request'
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
	// A certificate that fails verification is refused the same way every time.
	const certificate = status === undefined ? readCertificateFailure(error) : undefined
	const shouldRetry =
		transport !== undefined || certificate !== undefined
			? false
			: parseShouldRetry(vendorHeader(error, ['x-should-retry']))
	const fields = error as { type?: unknown; param?: unknown; requestID?: unknown } | null
	// A message that already carries its body (Anthropic's) has the fields; one that is only the
	// parsed sentence (OpenAI's) gets them from the SDK error's own properties.
	const detail = carriesBody(message)
		? vendorDetail(message)
		: structuredVendorDetail({
				message,
				type: fields?.type,
				code: exactProviderCode,
				param: fields?.param,
				requestId: fields?.requestID ?? vendorHeader(error, REQUEST_ID_HEADERS),
			})
	return new ProviderRequestError({
		kind,
		providerId: input.providerId,
		...(certificate !== undefined
			? { providerCode: certificate }
			: exactProviderCode !== undefined
				? { providerCode: exactProviderCode }
				: {}),
		...(status !== undefined ? { status } : {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		...(detail !== undefined ? { detail } : {}),
		...(shouldRetry !== undefined ? { shouldRetry } : {}),
		...(transport !== undefined ? { transport } : {}),
	})
}

/** Anthropic's SDK words a failure "<status> <JSON body>"; OpenAI's is "<status> <sentence>", which may itself hold a brace. */
function carriesBody(message: string): boolean {
	const rest = message.replace(/^\d{3}\s+/, '').trim()
	if (!rest.startsWith('{')) return false
	try {
		const parsed: unknown = JSON.parse(rest)
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
	} catch {
		return false
	}
}

function parsedBody(body: unknown): Record<string, unknown> | undefined {
	let decoded = body
	if (typeof decoded === 'string') {
		try {
			decoded = JSON.parse(decoded)
		} catch {
			return undefined
		}
	}
	return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
		? (decoded as Record<string, unknown>)
		: undefined
}

/** `type`/`status`, `code` and `param` of a `{ error: {...} }` body, only where it spells them. */
function bodyErrorFields(body: Record<string, unknown> | undefined): {
	type?: unknown
	code?: unknown
	param?: unknown
} {
	const inner =
		body && typeof body.error === 'object' && body.error !== null
			? (body.error as Record<string, unknown>)
			: undefined
	if (!inner) return {}
	// Google names its type `status` ("PERMISSION_DENIED") and sends a numeric `code` that is the HTTP status.
	return {
		type: inner.type ?? (typeof inner.status === 'string' ? inner.status : undefined),
		code: typeof inner.code === 'string' ? inner.code : undefined,
		param: inner.param,
	}
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
	/** The response's request ID header, when the driver read one. */
	readonly requestId?: string | null
	/** The response's `x-should-retry` header, when the driver read one. */
	readonly shouldRetry?: string | null
	readonly now?: number
}): ProviderRequestError {
	const kind = classifyProviderHttpStatus(input.status, input.body)
	const retryAfterMs = parseRetryAfterMs(input.retryAfter, input.now ?? Date.now())
	const body = parsedBody(input.body)
	const bodyError = bodyErrorFields(body)
	const detail = body
		? structuredVendorDetail({
				message: vendorDetail(input.body),
				type: bodyError.type,
				code: bodyError.code,
				param: bodyError.param,
				requestId: input.requestId,
			})
		: vendorDetail(input.body)
	const exactProviderCode = providerCode(input.body)
	const shouldRetry = parseShouldRetry(input.shouldRetry)
	return new ProviderRequestError({
		kind,
		providerId: input.providerId,
		...(exactProviderCode !== undefined ? { providerCode: exactProviderCode } : {}),
		status: input.status,
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
		...(detail !== undefined ? { detail } : {}),
		...(shouldRetry !== undefined ? { shouldRetry } : {}),
	})
}
