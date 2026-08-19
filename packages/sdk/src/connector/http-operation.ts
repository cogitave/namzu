const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_RESPONSE_BYTES = 2_147_483_647

// These headers can change where an already-validated URL is routed. Connector
// method input is commonly model-authored, while the base URL and credentials
// are host-configured. Letting the former supply `Host` would attach the
// latter's bearer/cookie headers to a different virtual host on the same
// socket. Proxy credentials are equally outside method-input authority.
const FORBIDDEN_CONNECTOR_INPUT_HEADERS = new Set([
	'host',
	'proxy-authorization',
	'proxy-connection',
])

export const DEFAULT_CONNECTOR_REQUEST_TIMEOUT_MS = 30_000
export const CONNECTOR_HEALTH_TIMEOUT_MS = 5_000
export const DEFAULT_CONNECTOR_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export function validateConnectorTimeoutMs(value: number, label: string): number {
	if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
		throw new Error(
			`${label} must be an integer from 1 to ${MAX_TIMER_DELAY_MS}; received ${String(value)}`,
		)
	}
	return value
}

export function validateConnectorMaxResponseBytes(value: number, label: string): number {
	if (!Number.isInteger(value) || value < 1 || value > MAX_RESPONSE_BYTES) {
		throw new Error(
			`${label} must be an integer from 1 to ${MAX_RESPONSE_BYTES}; received ${String(value)}`,
		)
	}
	return value
}

export function requireSafeConnectorInputHeaders(
	headers: Readonly<Record<string, string>> | undefined,
	label: string,
): void {
	if (!headers) return
	for (const name of Object.keys(headers)) {
		if (FORBIDDEN_CONNECTOR_INPUT_HEADERS.has(name.toLowerCase())) {
			throw new Error(`${label} cannot set routing header "${name}"`)
		}
	}
}

export function requireHttpUrl(value: string, label: string): URL {
	const parsed = new URL(value)
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`${label} must use http: or https:; received ${parsed.protocol}`)
	}
	return parsed
}

export function requireSameOrigin(value: string, configuredOrigin: string, label: string): URL {
	const parsed = requireHttpUrl(value, label)
	if (parsed.origin !== configuredOrigin) {
		throw new Error(
			`${label} must stay on the configured connector origin ${configuredOrigin}; received ${parsed.origin}`,
		)
	}
	return parsed
}

function timeoutError(label: string, timeoutMs: number): Error {
	const error = new Error(`${label} timed out after ${timeoutMs}ms`)
	error.name = 'TimeoutError'
	return error
}

function responseSizeError(maxBytes: number): Error {
	const error = new Error(`Response body exceeded the configured ${maxBytes}-byte limit`)
	error.name = 'ResponseSizeError'
	return error
}

/**
 * Read a platform response without allocating beyond the connector's byte
 * budget. `Content-Length` is only an early refusal; the streaming count is
 * authoritative because chunked and dishonest responses omit or understate it.
 */
export async function readConnectorResponseBody(
	response: Response,
	operation: ConnectorHttpOperation,
	maxBytes: number,
): Promise<unknown> {
	const contentType = response.headers.get('content-type') ?? ''
	const contentLength = response.headers.get('content-length')
	if (contentLength !== null) {
		const declaredBytes = Number(contentLength)
		if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
			const error = responseSizeError(maxBytes)
			operation.cancel(error)
			throw error
		}
	}

	// A real fetch Response has a byte stream whenever it has a body. The
	// fallback preserves compatibility with body-less responses and injected
	// Response-shaped test doubles; there are no remote bytes to stream when
	// the platform reports `body === null`.
	if (!response.body) {
		return operation.wait(
			contentType.includes('application/json') ? response.json() : response.text(),
		)
	}

	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let totalBytes = 0
	try {
		while (true) {
			const { done, value } = await operation.wait(reader.read())
			if (done) break
			totalBytes += value.byteLength
			if (totalBytes > maxBytes) {
				const error = responseSizeError(maxBytes)
				void reader.cancel(error).catch(() => undefined)
				operation.cancel(error)
				throw error
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}

	const bytes = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	const text = new TextDecoder().decode(bytes)
	return contentType.includes('application/json') ? JSON.parse(text) : text
}

/**
 * One whole HTTP operation boundary: fetch and body reads share one clock.
 *
 * The promise race is intentional. Forwarding a signal cannot settle a custom
 * fetch/body implementation that ignores it, and a connector lifecycle is a
 * public entry point independent of the run executor's own tool deadline.
 */
export class ConnectorHttpOperation {
	readonly signal: AbortSignal
	private readonly controller = new AbortController()
	private readonly aborted: Promise<never>
	private readonly callerSignal: AbortSignal | undefined
	private readonly onCallerAbort: (() => void) | undefined
	private readonly timer: ReturnType<typeof setTimeout>
	private rejectAbort!: (reason: unknown) => void
	private hasCause = false
	private firstCause: unknown

	constructor(callerSignal: AbortSignal | undefined, timeoutMs: number, label: string) {
		callerSignal?.throwIfAborted()
		this.signal = this.controller.signal
		this.callerSignal = callerSignal
		this.aborted = new Promise<never>((_resolve, reject) => {
			this.rejectAbort = reject
		})
		this.onCallerAbort = callerSignal ? () => this.stop(callerSignal.reason) : undefined
		callerSignal?.addEventListener('abort', this.onCallerAbort as () => void, { once: true })
		this.timer = setTimeout(() => this.stop(timeoutError(label, timeoutMs)), timeoutMs)
	}

	get cause(): unknown {
		return this.firstCause
	}

	async wait<T>(operation: Promise<T>): Promise<T> {
		try {
			return await Promise.race([operation, this.aborted])
		} catch (error) {
			if (
				this.hasCause &&
				error instanceof Error &&
				(error.name === 'AbortError' || error.name === 'TimeoutError')
			) {
				throw this.firstCause
			}
			throw error
		}
	}

	close(): void {
		clearTimeout(this.timer)
		if (this.callerSignal && this.onCallerAbort) {
			this.callerSignal.removeEventListener('abort', this.onCallerAbort)
		}
	}

	cancel(reason: unknown): void {
		this.stop(reason)
	}

	private stop(reason: unknown): void {
		if (this.hasCause) return
		this.hasCause = true
		this.firstCause = reason
		// Reject the owned wait before aborting transport. A fetch implementation
		// may synchronously translate transport abort into a generic AbortError;
		// that fallout must not erase the caller/deadline cause that won first.
		this.rejectAbort(reason)
		this.controller.abort(reason)
	}
}
