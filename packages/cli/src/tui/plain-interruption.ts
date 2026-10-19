export { debugRequested } from '../debug-requested.js'
import { formatSpan, localEndpoint, productName } from './person-terms.js'
import { terminalDisplayText } from './terminal-display.js'
import { type Interruption, describeTurnInterruption, retryAfterMs } from './turn-interruption.js'
import { ZEN_FREE_REFUSED_WHAT, isZenFreeTierRefusal } from './zen-free-refusal.js'

/**
 * What the terminal app tells a person when a reply fails or pauses.
 *
 * One plain sentence plus one next step, the provider by its product name,
 * and at most one line carrying the provider's own message when that adds
 * information. No catalog ids, no checkpoint ids, no HTTP status lines, no raw
 * JSON, no config-key names. `describeTurnInterruption` keeps the structured
 * form for `--json`, `exec`, scheduled runs and the ACP host; this module is
 * only for the interactive screen.
 */

export type InterruptionKind =
	| 'auth'
	| 'permission'
	| 'rate_limit'
	| 'server'
	| 'network'
	| 'model_not_found'
	| 'context'
	| 'content'
	| 'bad_request'
	| 'unknown'

/** Which of the plain-language cases an interruption is, from facts the event carries. */
export function classifyInterruption(event: Interruption): InterruptionKind {
	const id = event.explanation?.id ?? ''
	if (id === 'provider.permission') return 'permission'
	if (id === 'provider.auth') return 'auth'
	if (id.startsWith('provider.rate_limit')) return 'rate_limit'
	if (id === 'provider.unavailable') return 'server'
	if (id === 'provider.network') return 'network'
	if (id === 'provider.model_not_found') return 'model_not_found'
	if (id === 'provider.context_overflow') return 'context'
	if (id === 'provider.content_filter') return 'content'
	switch (event.providerError?.kind) {
		case 'auth':
			return 'auth'
		case 'throttle':
			return 'rate_limit'
		case 'server':
			return 'server'
		case 'network':
			return 'network'
		case 'context_overflow':
			return 'context'
		case 'bad_request':
			return 'bad_request'
		default:
			return 'unknown'
	}
}

const ID_LIKE =
	/\b(?:req|request|resp|msg|org|proj)[_-][A-Za-z0-9]{6,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{12,}\b/gi

/** The human sentence inside a vendor body, or nothing when there is none. */
export function cleanVendorMessage(value: string | undefined): string | undefined {
	if (!value) return undefined
	let text = terminalDisplayText(value)
	// Pull the message out of a JSON body instead of printing the body.
	const open = text.indexOf('{')
	if (open >= 0) {
		const close = text.lastIndexOf('}')
		let extracted: string | undefined
		try {
			const parsed: unknown = JSON.parse(text.slice(open, close + 1))
			extracted = jsonMessage(parsed)
		} catch {
			extracted = undefined
		}
		text = extracted ?? `${text.slice(0, open)} ${text.slice(close + 1)}`
	}
	text = text
		.replace(/<[^>]*>/g, ' ')
		.replace(ID_LIKE, '')
		.replace(/^\s*(?:\w[\w.-]*\s*)?\(?HTTP\s*\d{3}\)?\s*[—–:-]*\s*/i, '')
		.replace(/^\s*\d{3}\b\s*[—–:/-]*\s*/, '')
		.replace(/^\s*(?:[A-Za-z]*Error):\s*/, '')
		.replace(/^\s*[A-Za-z]+Provider:\s*/, '')
		.replace(/\s+/g, ' ')
		.trim()
	// A leftover that is only a status word or punctuation says nothing.
	if (text.length < 4 || !/[a-z]{3}/i.test(text)) return undefined
	return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

function jsonMessage(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined
	const record = value as Record<string, unknown>
	if (typeof record.message === 'string') return record.message
	return jsonMessage(record.error) ?? undefined
}

function sameIdea(a: string, b: string): boolean {
	const norm = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim()
	const x = norm(a)
	const y = norm(b)
	return x.length === 0 || y.length === 0 || x === y || x.includes(y) || y.includes(x)
}

function providerIdOf(event: Interruption): string | undefined {
	const id = event.providerError?.providerId ?? event.failure?.details?.providerId
	return typeof id === 'string' ? id : undefined
}

function providerOf(event: Interruption): string | undefined {
	return productName(providerIdOf(event))
}

function statusOf(event: Interruption): number | undefined {
	const status = event.failure?.details?.status
	return typeof status === 'number' ? status : undefined
}

function modelOf(event: Interruption): string | undefined {
	const raw = [event.kind === 'paused' ? event.reason : event.message]
		.join(' ')
		.match(/\bmodel\b[^A-Za-z0-9]{0,4}([A-Za-z0-9][\w./:-]{1,60})/)
	return raw?.[1]
}

interface Copy {
	/** The sentence that says what happened. */
	readonly what: string
	/** What to do about it. */
	readonly next: string
}

function copyFor(
	kind: InterruptionKind,
	name: string,
	event: Interruption,
	modelId: string | undefined,
	localAt?: string,
): Copy {
	switch (kind) {
		case 'auth':
			return {
				what: `${name} did not accept your API key.`,
				next: 'Check it in /setup, or pick another provider with /model.',
			}
		case 'permission':
			return {
				what: `${name} does not allow this account to use that model.`,
				next: 'Pick another model with /model.',
			}
		case 'rate_limit': {
			const wait = retryAfterMs(event)
			return {
				what: `${name} is limiting requests right now.`,
				next:
					wait === undefined
						? 'Wait a moment, then send again.'
						: `Try again in about ${formatSpan(wait)}.`,
			}
		}
		case 'server':
			return {
				what: `${name} is having problems on its side.`,
				next: 'Try again in a minute.',
			}
		case 'network':
			return localAt
				? {
						what: `Namzu could not reach ${name} at ${localAt}.`,
						next: 'Start it, then try again.',
					}
				: {
						what: `Namzu could not reach ${name}.`,
						next: 'Check your internet connection, then try again.',
					}
		case 'model_not_found':
			return {
				what: modelId
					? `${name} has no model called ${modelId}.`
					: `${name} does not know that model.`,
				next: 'Run /model to pick another.',
			}
		case 'context':
			return {
				what: 'This conversation is too long for the model to read.',
				next: 'Run /compact to summarise it, or start a new one with /new.',
			}
		case 'content':
			return {
				what: `${name} declined to answer that.`,
				next: 'Rephrase your message and send it again.',
			}
		case 'bad_request':
			return {
				what: `${name} could not process this message.`,
				next: 'Send it again, or start a new conversation with /new.',
			}
		case 'unknown':
			return {
				what: 'This reply stopped because of a problem.',
				next: 'Send your message again, or run with --debug to see details.',
			}
	}
}

const SAYS_IT_ALL: ReadonlySet<InterruptionKind> = new Set([
	'auth',
	'model_not_found',
	'server',
	'network',
])

const GUIDANCE =
	/\b(select|use|run|check|try|set|pick|choose|remove|enable|press|wait|add|switch)\b/i

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The same sentence without its closing period, so a prefix can join it. */
function stem(sentence: string): string {
	return sentence.replace(/\.$/, '')
}

export interface PlainInterruptionOptions {
	/** Append the structured detail too (`NAMZU_DEBUG=1`, `--debug`). */
	readonly debug?: boolean
	/** The model the person chose, for "no model called ..." (the event does not name it reliably). */
	readonly model?: string
	/** The provider's configured base URL, so a local server is named as one. */
	readonly baseUrl?: string
}

/**
 * Person-facing text for a failed or paused reply.
 *
 * A failure is `<what happened> <next step>` plus, when the provider said
 * something that adds information, one `<Provider> said: ...` line. A pause reads
 * `Paused: <what happened> Press Enter to try again, or type a new message.`
 */
export function describePlainInterruption(
	event: Interruption,
	options: PlainInterruptionOptions = {},
): string {
	if (event.kind === 'paused' && event.handoff) {
		const one = (text: string, max: number): string => {
			const flat = terminalDisplayText(text).replace(/\s+/g, ' ').trim()
			return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
		}
		const rows = [`Paused, and needs you: ${one(event.handoff.reason, 480)}`]
		for (const [key, value] of Object.entries(event.handoff.detail ?? {})) {
			rows.push(`${one(key, 60)}: ${one(value, 240)}`)
		}
		return rows.join('\n')
	}
	if (event.kind === 'error' && event.turnInProgress) {
		// The conversation still holds an open turn. In words, never its id.
		switch (event.turnInProgress.state) {
			case 'running':
				return 'A reply is still running in this conversation. Wait for it to finish, or press Esc to stop it.'
			case 'paused':
				return 'The last reply is paused and waiting for you. Press Enter to continue it, or run /abandon to close it and send your message.'
			case 'interrupted':
				return 'The last reply was cut off when Namzu closed. Run /resume to continue it, or /abandon to close it.'
		}
	}
	const kind = classifyInterruption(event)
	const name = providerOf(event) ?? 'The provider'
	let copy = copyFor(
		kind,
		name,
		event,
		kind === 'model_not_found' ? (options.model ?? modelOf(event)) : undefined,
		kind === 'network' ? localEndpoint(providerIdOf(event), options.baseUrl) : undefined,
	)
	const rawReason = event.kind === 'paused' ? event.reason : event.message
	// Zen's keyless free tier was refused: no key was sent, so nothing was wrong with one.
	const freeRefused = isZenFreeTierRefusal({
		providerId: providerIdOf(event),
		status: event.providerError?.status ?? statusOf(event),
		detail: event.providerError?.detail ?? rawReason,
	})
	if (freeRefused) {
		copy = {
			what: ZEN_FREE_REFUSED_WHAT,
			next: 'Try again in a while, or choose another provider with /model. A Zen API key also works.',
		}
	}
	// The provider's own sentence: its detail field, or a message inside a JSON
	// body in the raw reason. A raw reason with no body is only our own wrapper.
	const vendor =
		cleanVendorMessage(event.providerError?.detail) ??
		(rawReason.includes('{') || kind === 'unknown' ? cleanVendorMessage(rawReason) : undefined)
	const informative =
		!freeRefused &&
		vendor !== undefined &&
		!sameIdea(vendor, copy.what) &&
		!sameIdea(vendor, copy.next) &&
		// Unknown failures have no sentence of their own: the cleaned message is the sentence.
		kind !== 'unknown' &&
		// For these the headline already says all there is; the vendor text is its echo.
		!SAYS_IT_ALL.has(kind)
	const rows: string[] = []
	if (event.kind === 'paused') {
		const what = kind === 'unknown' && vendor ? `${capitalise(stem(vendor))}.` : copy.what
		const wait = kind === 'rate_limit' ? retryAfterMs(event) : undefined
		const tail =
			wait === undefined
				? 'Press Enter to try again, or type a new message.'
				: `Wait about ${formatSpan(wait)}, then press Enter to try again, or type a new message.`
		rows.push(`Paused: ${what} ${tail}`)
	} else if (kind === 'unknown' && vendor) {
		// The failure's own sentence. It already says what to do when it names an
		// action (for example "Select 'x' instead"); otherwise add the generic step.
		const sentence = `${capitalise(stem(vendor))}.`
		rows.push(GUIDANCE.test(vendor) ? sentence : `${sentence} ${copy.next}`)
	} else {
		rows.push(`${copy.what} ${copy.next}`)
	}
	if (informative && vendor) rows.push(`${name} said: ${vendor}`)
	if (options.debug) rows.push('', describeTurnInterruption(event))
	return rows.join('\n')
}

/**
 * What the working row says while the kernel waits to ask the provider again:
 * the sentence for the failure, and the clock it counts down to.
 *
 * The first two failures of a plain server fault read only "The request
 * failed"; the specific sentence appears from the third try on, or at once
 * when the cause is already plain (no connection, or a limit).
 */
export interface ProviderWaitNotice {
	readonly what: string
	/** Wall-clock time the next try starts. */
	readonly retryAt: number
	readonly attempt: number
	readonly maxRetries: number
}

export function describeProviderWait(
	event: {
		readonly delayMs: number
		readonly attempt: number
		readonly maxRetries: number
		readonly code: string
		readonly status?: number
	},
	providerId?: string,
	baseUrl?: string,
	now: number = Date.now(),
): ProviderWaitNotice {
	const name = productName(providerId) ?? 'The provider'
	const localAt = localEndpoint(providerId, baseUrl)
	const limited = event.code === 'rate_limit' || event.status === 429
	const offline = event.code === 'network' || event.code === 'timeout'
	const plain = limited || offline || event.attempt >= Math.min(3, event.maxRetries)
	const what = !plain
		? 'The request failed.'
		: limited
			? `${name} is limiting requests.`
			: offline
				? `Namzu could not reach ${name}${localAt ? ` at ${localAt}` : ''}.`
				: `${name} is having problems on its side.`
	return {
		what,
		retryAt: now + event.delayMs,
		attempt: event.attempt,
		maxRetries: event.maxRetries,
	}
}

/** The dim half of the row: ` Retrying in 5s · attempt 2/10`, recomputed against the clock. */
export function describeProviderWaitClock(notice: ProviderWaitNotice, now: number): string {
	const left = Math.max(0, Math.ceil((notice.retryAt - now) / 1000)) * 1000
	return `Retrying in ${formatSpan(left)} · attempt ${notice.attempt}/${notice.maxRetries}`
}
