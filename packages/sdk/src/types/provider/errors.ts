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
	/**
	 * Override the code's own verdict on retryability.
	 *
	 * Omit and the code decides, which is the normal path. Set it when
	 * something closer to the failure already said so — see
	 * {@link declaredRetryable}.
	 */
	readonly retryable?: boolean
	readonly cause?: unknown
}

/**
 * A `retryable` flag declared anywhere on the cause chain.
 *
 * Retryability was derived solely from namzu's own code set, so a provider
 * that says outright "this one is safe to retry" was not listened to —
 * and the code set is a second-hand inference from status and wording that
 * necessarily lags every new failure shape a vendor invents. Read
 * duck-typed rather than through an interface, because the flag arrives on
 * a foreign SDK's error object that namzu does not control.
 *
 * The FIRST link that declares one wins: the outermost declaration is the
 * most recent statement about the failure, made by whichever layer knew
 * enough to make it.
 */
export function declaredRetryable(err: unknown): boolean | undefined {
	for (const link of causeChain(err)) {
		const declared = link.retryable
		if (typeof declared === 'boolean') return declared
	}
	return undefined
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
		// The code decides, unless something upstream already declared
		// otherwise. A vendor SDK that sets `retryable` on its own error is
		// making a first-hand statement about a failure it produced; namzu's
		// code set is a second-hand inference from status and wording, and
		// it necessarily lags every new failure shape a provider invents.
		// Deriving solely from the code discarded the better signal.
		this.retryable = init.retryable ?? RETRYABLE.has(init.code)
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
		m.includes('prompt is too long') ||
		// Real wordings that missed every phrase above and so classified as
		// a plain invalid request — which is not retryable, and which the
		// overflow rescue tests for by exact equality. The run died holding
		// the remedy.
		m.includes('too long for') ||
		m.includes('maximum length') ||
		m.includes('exceeds the maximum') ||
		m.includes('input is too large') ||
		m.includes('too large for')
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
 * Structural failure codes providers put on the error itself, or on the
 * `type` discriminator of a gateway's error body.
 *
 * These were extracted and then thrown away: the walked `code` fed only
 * the two transport-errno sets, so a provider that said
 * `context_length_exceeded` in the one field designed to say it was
 * answered with a substring search that did not match, filed as a plain
 * invalid request, and never reached the rescue that exists for exactly
 * this failure.
 *
 * A code is checked BEFORE the status because it is strictly more
 * specific: a 400 is a category, `context_length_exceeded` is the
 * diagnosis. Only unambiguous codes belong here — anything whose meaning
 * depends on the body stays with the message pass.
 */
const STRUCTURAL_CODES: Readonly<Record<string, ProviderErrorCode>> = {
	context_length_exceeded: 'context_length_exceeded',
	context_window_exceeded: 'context_length_exceeded',
	max_tokens_exceeded: 'context_length_exceeded',
	string_above_max_length: 'context_length_exceeded',
	rate_limit_exceeded: 'rate_limit',
	rate_limit_error: 'rate_limit',
	insufficient_quota: 'rate_limit',
	overloaded_error: 'overloaded',
	content_filter: 'content_filter',
	content_policy_violation: 'content_filter',
	invalid_api_key: 'auth',
	authentication_error: 'auth',
	permission_error: 'auth',
	model_not_found: 'not_found',
}

function codeFromStructure(err: unknown): ProviderErrorCode | undefined {
	for (const link of causeChain(err)) {
		for (const field of [link.code, link.type, (link.error as { type?: unknown })?.type]) {
			if (typeof field !== 'string') continue
			const mapped = STRUCTURAL_CODES[field.toLowerCase()]
			if (mapped) return mapped
		}
	}
	return undefined
}

/**
 * Turn whatever a driver threw into a {@link ProviderError}.
 *
 * Precedence is deliberate: a STRUCTURAL code is the most specific
 * signal, then HTTP status, then transport errno, then message text. `context_length_exceeded` is checked
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
/**
 * Every `ProviderErrorKind`, mapped to what the runtime acts on.
 *
 * Read structurally rather than with `instanceof`: a driver in one package
 * throws this and the runtime in another reads it, and two copies of the SDK
 * in one process make `instanceof` unreliable — the same reason
 * `isProviderRequestError` exists.
 *
 * `retryable` here is about whether resending the SAME request could succeed.
 * `context_overflow` is correctly false — an identical prompt overflows
 * identically — and it maps to `context_length_exceeded` so the loop can reach
 * for compaction, which is a different remedy than a retry.
 */
const KIND_TO_CODE: Readonly<Record<string, { code: ProviderErrorCode; retryable: boolean }>> = {
	throttle: { code: 'rate_limit', retryable: true },
	network: { code: 'network', retryable: true },
	server: { code: 'server_error', retryable: true },
	auth: { code: 'auth', retryable: false },
	context_overflow: { code: 'context_length_exceeded', retryable: false },
	bad_request: { code: 'invalid_request', retryable: false },
}

function classifyFromProviderRequestError(
	err: unknown,
	providerId: string | undefined,
	now: number,
): ProviderError | undefined {
	if (!(err instanceof Error) || err.name !== 'ProviderRequestError') return undefined
	const candidate = err as Error & {
		kind?: unknown
		providerId?: unknown
		status?: unknown
		retryAfterMs?: unknown
	}
	if (typeof candidate.kind !== 'string') return undefined
	const mapped = KIND_TO_CODE[candidate.kind]
	if (!mapped) return undefined

	const retryAfterMs =
		typeof candidate.retryAfterMs === 'number' ? candidate.retryAfterMs : readRetryAfterMs(err, now)

	return new ProviderError({
		code: mapped.code,
		message: err.message,
		retryable: mapped.retryable,
		cause: err,
		...(typeof candidate.providerId === 'string'
			? { providerId: candidate.providerId }
			: providerId !== undefined
				? { providerId }
				: {}),
		...(typeof candidate.status === 'number' ? { status: candidate.status } : {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
	})
}

export function classifyProviderError(
	err: unknown,
	providerId?: string,
	now: number = Date.now(),
): ProviderError {
	if (isProviderError(err)) return err

	// A driver that already classified its own failure is read FIRST, and by
	// its `kind` — the field it set on purpose.
	//
	// Without this the classifier fell through to the status heuristics, where
	// a `ProviderRequestError` carrying `kind: 'context_overflow'` and a 400
	// became `invalid_request`, non-retryable. Three of the six kinds landed
	// wrong that way, and the consequences were not cosmetic: the loop's
	// overflow branch tests for `context_length_exceeded`, so compaction relief
	// — the one provider failure this kernel can actually do something about —
	// was unreachable for exactly the drivers that had diagnosed it correctly.
	// A driver that classified its own error came out worse than one that did
	// not, which is the opposite of the incentive the type was created for.
	const fromKind = classifyFromProviderRequestError(err, providerId, now)
	if (fromKind) return fromKind

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
	// A first-hand statement from whoever produced the failure, if there
	// is one. It outranks the code's inference, not the code itself: the
	// classification still says WHAT went wrong.
	const declared = declaredRetryable(err)

	// The structural code first: it is the one field designed to say what
	// went wrong, and it is more specific than the status carrying it. A
	// 400 is a category; `context_length_exceeded` is the diagnosis.
	const structural = codeFromStructure(err)
	if (structural !== undefined) {
		return new ProviderError({
			code: structural,
			message,
			providerId,
			...(status !== undefined ? { status } : {}),
			...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
			...(declared !== undefined ? { retryable: declared } : {}),
			cause: err,
		})
	}

	// A 400 that is really a window overflow must not be filed as a plain
	// invalid_request: the caller can recover from one and not the other.
	if (messages.some((m) => codeFromMessage(m) === 'context_length_exceeded')) {
		return new ProviderError({
			code: 'context_length_exceeded',
			message,
			providerId,
			status,
			...(declared !== undefined ? { retryable: declared } : {}),
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
			...(declared !== undefined ? { retryable: declared } : {}),
			cause: err,
		})
	}

	if (errno !== undefined) {
		if (TIMEOUT_ERRNOS.has(errno)) {
			return new ProviderError({
				code: 'timeout',
				message,
				providerId,
				retryable: declared,
				cause: err,
			})
		}
		if (NETWORK_ERRNOS.has(errno)) {
			return new ProviderError({
				code: 'network',
				message,
				providerId,
				retryable: declared,
				cause: err,
			})
		}
	}

	// `fetch` rejects with a bare TypeError on transport failure.
	if (err instanceof TypeError && /fetch|network/i.test(message)) {
		return new ProviderError({
			code: 'network',
			message,
			providerId,
			retryable: declared,
			cause: err,
		})
	}

	// The unclassified tail is where a declared flag matters most: a
	// failure nobody has characterised lands on `unknown`, which is treated
	// as non-retryable — even when its own author said otherwise.
	return new ProviderError({
		code: fromMessage ?? 'unknown',
		message,
		providerId,
		retryAfterMs,
		retryable: declared,
		cause: err,
	})
}
