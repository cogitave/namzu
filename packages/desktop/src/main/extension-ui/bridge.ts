/**
 * The bridge between one page and its own extension, as a pure gate: nothing here touches Electron. A page
 * can reach only its own extension process, and only through the methods its manifest declares. Every
 * limit is a constant here and has a test; an error carries a fixed Namzu sentence per code, never text
 * from the extension.
 */

export const BRIDGE_VERSION = 1
export const MAX_MESSAGE_BYTES = 64 * 1024
export const HOST_REPLY_MAX_BYTES = 64 * 1024
export const MAX_IN_FLIGHT = 4
export const RATE_PER_SECOND = 20
export const RATE_BURST = 40
export const MAX_STRIKES = 3

export type BridgeErrorCode =
	| 'not-declared'
	| 'bad-params'
	| 'too-large'
	| 'rate-limited'
	| 'unavailable'
	| 'not-licensed'
	| 'gesture-required'
	| 'answer-dropped'
	| 'closed'

export const ERROR_SENTENCE: Readonly<Record<BridgeErrorCode, string>> = {
	'not-declared': 'This page is not allowed to do that.',
	'bad-params': 'That request does not fit what the extension accepts.',
	'too-large': 'That is too large.',
	'rate-limited': 'Too many requests at once. Try again in a moment.',
	unavailable: 'The extension is not running right now.',
	'not-licensed': 'The extension needs a licence to do that.',
	'gesture-required': 'That needs a click or a key press in the page.',
	'answer-dropped': 'The extension answered in a way Namzu does not accept.',
	closed: 'This page was stopped.',
}

export type HostMethod = 'theme' | 'locale' | 'state' | 'openNamzu'
export const OPEN_NAMZU_TARGETS = [
	'notice',
	'permissions',
	'licence',
	'record',
	'what-is-collected',
] as const
export type OpenTarget = (typeof OPEN_NAMZU_TARGETS)[number]

export interface Envelope {
	v: 1
	id: number
	m: string
	p?: unknown
	a?: boolean
}
export type Reply =
	| { v: 1; id: number; ok: true; r: unknown }
	| { v: 1; id: number; ok: false; e: { code: BridgeErrorCode; message: string } }

/** What the main process does for a page; each method is only reached after the gate has allowed it. */
export interface BridgeBackend {
	/** `query:<id>` or `action:<id>`: through the engine, which checks params and answer against the manifest. */
	extension(method: string, params: unknown, activation: boolean): Promise<unknown>
	theme(): unknown
	locale(): unknown
	state(): unknown
	/** Namzu opens one of its own screens; the page draws nothing of it and reads nothing back. */
	openNamzu(target: OpenTarget): void
}

export interface BridgeOptions {
	readonly allow: readonly string[]
	readonly host: readonly HostMethod[]
	/** The size an answer of each declared method may have (from the manifest). */
	readonly maxBytes: Readonly<Record<string, number>>
	readonly backend: BridgeBackend
	readonly now: () => number
	/** Called once, when three strikes close the page. */
	readonly onClose: (reason: 'strikes') => void
}

const fail = (id: number, code: BridgeErrorCode): Reply => ({
	v: 1,
	id,
	ok: false,
	e: { code, message: ERROR_SENTENCE[code] },
})

/** Plain JSON only: functions, ArrayBuffer, Blob, MessagePort and every other transferable are refused. */
export function isPlainJson(value: unknown, depth = 0): boolean {
	if (depth > 8) return false
	if (value === null) return true
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return true
		case 'number':
			return Number.isFinite(value)
		case 'object': {
			if (Array.isArray(value)) return value.every((v) => isPlainJson(v, depth + 1))
			const proto = Object.getPrototypeOf(value)
			if (proto !== Object.prototype && proto !== null) return false
			return Object.values(value as Record<string, unknown>).every((v) => isPlainJson(v, depth + 1))
		}
		default:
			return false
	}
}

export class PageBridge {
	private strikes = 0
	private inFlight = 0
	private tokens = RATE_BURST
	private last: number
	private closed = false

	constructor(private readonly o: BridgeOptions) {
		this.last = o.now()
	}

	get isClosed(): boolean {
		return this.closed
	}

	private strike(): void {
		this.strikes++
		if (this.strikes >= MAX_STRIKES && !this.closed) {
			this.closed = true
			this.o.onClose('strikes')
		}
	}

	private take(): boolean {
		const t = this.o.now()
		this.tokens = Math.min(RATE_BURST, this.tokens + ((t - this.last) / 1000) * RATE_PER_SECOND)
		this.last = t
		if (this.tokens < 1) return false
		this.tokens -= 1
		return true
	}

	/**
	 * One message from the page. `activation` is stamped by Namzu's own preload from the page's real
	 * user-activation state, never taken from the message. Always answers; never throws.
	 */
	async handle(message: unknown, activation: boolean): Promise<Reply | undefined> {
		if (this.closed) return undefined
		// An unknown shape, a bad version, a non-integer id or an oversized message is a strike.
		let size = 0
		try {
			size = Buffer.byteLength(JSON.stringify(message) ?? '')
		} catch {
			this.strike()
			return undefined
		}
		const m = message as Partial<Envelope> | null
		if (
			!m ||
			typeof m !== 'object' ||
			m.v !== BRIDGE_VERSION ||
			!Number.isSafeInteger(m.id) ||
			(m.id as number) <= 0 ||
			typeof m.m !== 'string' ||
			m.m.length > 80 ||
			!isPlainJson(m.p ?? null)
		) {
			this.strike()
			return Number.isSafeInteger((m as { id?: unknown } | null)?.id)
				? fail((m as { id: number }).id, 'bad-params')
				: undefined
		}
		const id = m.id as number
		if (size > MAX_MESSAGE_BYTES) {
			this.strike()
			return fail(id, 'too-large')
		}
		if (!this.take()) return fail(id, 'rate-limited')
		if (this.inFlight >= MAX_IN_FLIGHT) return fail(id, 'rate-limited')
		const method = m.m as string
		this.inFlight++
		try {
			return await this.dispatch(id, method, m.p ?? null, activation)
		} catch {
			return fail(id, 'unavailable')
		} finally {
			this.inFlight--
		}
	}

	private async dispatch(
		id: number,
		method: string,
		params: unknown,
		activation: boolean,
	): Promise<Reply> {
		if (method.startsWith('host:')) {
			const which = method.slice(5) as HostMethod
			if (!this.o.host.includes(which)) return fail(id, 'not-declared')
			switch (which) {
				case 'theme':
					return this.sized(id, this.o.backend.theme(), HOST_REPLY_MAX_BYTES)
				case 'locale':
					return this.sized(id, this.o.backend.locale(), HOST_REPLY_MAX_BYTES)
				case 'state':
					return this.sized(id, this.o.backend.state(), HOST_REPLY_MAX_BYTES)
				case 'openNamzu': {
					const where = (params as { where?: unknown } | null)?.where
					if (!(OPEN_NAMZU_TARGETS as readonly unknown[]).includes(where))
						return fail(id, 'bad-params')
					this.o.backend.openNamzu(where as OpenTarget)
					return { v: 1, id, ok: true, r: { opened: true } }
				}
				default:
					return fail(id, 'not-declared')
			}
		}
		// Only what this page's manifest lists; anything else, including another extension's methods and
		// Namzu's own `namzu/*` calls, is not a method here at all.
		if (!this.o.allow.includes(method) || !/^(?:query|action):[a-z][a-z0-9-]*$/.test(method))
			return fail(id, 'not-declared')
		try {
			const result = await this.o.backend.extension(method, params, activation)
			return this.sized(id, result, this.o.maxBytes[method] ?? HOST_REPLY_MAX_BYTES)
		} catch (e) {
			const code = (e as { code?: string }).code
			const map: Record<string, BridgeErrorCode> = {
				'bad-params': 'bad-params',
				'gesture-required': 'gesture-required',
				'not-running': 'unavailable',
				'query-unreachable': 'unavailable',
				'query-timeout': 'unavailable',
				'query-closed': 'unavailable',
				R1: 'not-declared',
				R2: 'answer-dropped',
				R3: 'answer-dropped',
				'query-too-big': 'too-large',
				'query-invalid': 'answer-dropped',
				'not-licensed': 'not-licensed',
			}
			return fail(id, (code && map[code]) || 'unavailable')
		}
	}

	private sized(id: number, value: unknown, max: number): Reply {
		let bytes = 0
		try {
			bytes = Buffer.byteLength(JSON.stringify(value ?? null))
		} catch {
			return fail(id, 'answer-dropped')
		}
		if (bytes > max) return fail(id, 'too-large')
		return { v: 1, id, ok: true, r: value ?? null }
	}
}
