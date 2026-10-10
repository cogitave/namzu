/**
 * What a person reads when a reply fails. The runtime's own sentences name internal parts
 * (receipts, accounting, HTTP codes, vendor JSON); this turns them into one plain sentence and a
 * next step, and keeps the original behind a "Details" disclosure. The mapping reads only text, so
 * it can be tested without a window.
 */

export type FailureAction =
	| 'try-again'
	| 'settings'
	| 'new-conversation'
	/** Close the stopped turn, keep working here, and put the message back in the box. */
	| 'continue'
	/** Carry the saved message and its files to a new conversation of the same project. */
	| 'copy-to-new'

export interface FriendlyFailure {
	kind:
		| 'connection'
		| 'rejected-key'
		| 'missing-key'
		| 'rate-limit'
		| 'out-of-credit'
		| 'model-access'
		| 'model-missing'
		| 'timeout'
		| 'too-large'
		| 'bad-reply'
		| 'server'
		| 'too-long'
		| 'rejected-request'
		| 'lost-connection'
		| 'cannot-repeat'
		| 'busy'
		| 'other'
	text: string
	/** In the order the buttons are drawn; the first is the one that usually fixes it. */
	actions: FailureAction[]
	/** The original message with markup, long tokens and key-shaped text removed. */
	details?: string
}

const PROVIDER_NAMES = new Map<string, string>([
	['anthropic', 'Anthropic'],
	['openai', 'OpenAI'],
	['codex', 'ChatGPT'],
	['google', 'Google'],
	['openrouter', 'OpenRouter'],
	['zen', 'OpenCode Zen'],
	['zen-go', 'OpenCode Go'],
	['ollama', 'Ollama'],
	['lmstudio', 'LM Studio'],
	['mistral', 'Mistral'],
	['groq', 'Groq'],
	['xai', 'xAI'],
	['deepseek', 'DeepSeek'],
])

/** The name a person knows a provider by; an unknown id is capitalised rather than shown raw. */
export function providerName(id: string | undefined, label?: string): string {
	const known = id ? PROVIDER_NAMES.get(id) : undefined
	if (known) return known
	if (label?.trim()) return label.replace(/\s*\(.*\)\s*$/, '').trim()
	if (!id) return 'the provider'
	return id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * The message as a support note: markup gone, key-shaped text hidden, one run of text, bounded. A
 * vendor that echoes the start of a key in its error never reaches the screen.
 */
export function sanitizeDetails(raw: string): string {
	const text = raw
		.replace(/<[^>]*>/g, ' ')
		.replace(/\b(?:sk|pk|rk|key|tok|ghp|xox[a-z])[-_][A-Za-z0-9*._-]{4,}/gi, '[hidden]')
		.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[hidden]')
		.replace(/\b(\d{3})(?:\s+\1\b)+/g, '$1')
		.replace(/\s+/g, ' ')
		.trim()
	return text.length > 500 ? `${text.slice(0, 499)}…` : text
}

/** The model a vendor says the account cannot use. */
const MODEL_ACCESS = /(?:access to|use|allowed to use) (?:the )?model[ :`'"]*([\w.:/-]*[\w])/i
/** A quota the account has used up. A free-tier rate limit that merely suggests a payment method is not this. */
const OUT_OF_CREDIT =
	/insufficient[_ ]quota|exceeded your current quota|out of credit|credit balance is too low/i
const KEY_PROBLEM = /api key|invalid[_ ]key|unauthori[sz]ed|authentication/i

const PROVIDER_FAILURE = /^([a-z0-9][a-z0-9-]*)(?: \(HTTP (\d{3})\))? — ([^:]+?)(?:: ([\s\S]*))?$/i

/** What Details says about usage nobody reported for a request that failed. One send is one reply, however often it was retried. */
export function unknownUsageDetail(): string {
	return 'No usage was reported for the failed attempts.'
}
export const UNKNOWN_USAGE_DETAIL = unknownUsageDetail()

/** Repeated runs of words (an HTML title and its heading) read once. */
function collapseRepeats(text: string): string {
	let previous = ''
	let current = text
	while (current !== previous) {
		previous = current
		current = current.replace(/\b((?:\S+\s+){0,5}\S+)\s+\1\b/gi, '$1')
	}
	return current
}

/** Thousands grouped, so a token count reads as 131,452. Short numbers (statuses, years) stay. */
function groupNumbers(text: string): string {
	return text.replace(/(?<![\d.,])\d{5,}(?![\d.,])/g, (digits) =>
		Number(digits).toLocaleString('en-US'),
	)
}

const REQUEST_ID =
	/,?\s*["']?\b(?:cf[- ]?)?(?:ray id|request[ _-]?id)["']?\s*[:=]?\s*["']?([A-Za-z0-9_-]{8,})["']?/i
const PROJECT_ID = /\bproj_[A-Za-z0-9]{4,}\b/
/** The runtime's own wording for a kind of failure, as a person reads it in Details. */
const DETAIL_SENTENCE: Record<string, string> = {
	'the provider rejected the request credentials': 'access was refused',
}
const REQUEST_TOKEN = /\breq_[A-Za-z0-9]{8,}\b/

/**
 * The provider's own wording as plain lines: who answered and with what, then a labelled request
 * ID when the vendor sent one. Nothing is said twice and no accounting words appear.
 */
function plainProviderDetails(raw: string): string[] {
	const matched = PROVIDER_FAILURE.exec(raw.trim())
	if (!matched) return [raw]
	const name = providerName(matched[1]?.toLowerCase())
	let answer = sanitizeDetails(matched[4] ?? '')
	const requestId = REQUEST_ID.exec(answer)?.[1] ?? REQUEST_TOKEN.exec(answer)?.[0]
	const projectId = PROJECT_ID.exec(answer)?.[0]
	answer = answer
		.replace(/\b(?:project\s+)?proj_[A-Za-z0-9]{4,}\b/gi, (hit) =>
			/^project/i.test(hit) ? 'Your project' : 'your project',
		)
		.replace(REQUEST_ID, ' ')
		.replace(REQUEST_TOKEN, ' ')
		.replace(/\b(?:cloudflare|nginx(?:\/[\d.]+)?)\b/gi, ' ')
		.replace(/\bstatus code\b/gi, ' ')
		.replace(/\(\s*no body\s*\)/gi, ' ')
		.replace(/,\s*([}\]])/g, '$1')
		.replace(/\s+/g, ' ')
		.trim()
	answer = groupNumbers(collapseRepeats(answer))
	const status = matched[2] && !answer.startsWith(matched[2]) ? `${matched[2]} ` : ''
	const rawSentence = (matched[3] ?? '').trim().replace(/\.$/, '')
	const sentence = DETAIL_SENTENCE[rawSentence.toLowerCase()] ?? rawSentence
	const head = `${name}: ${sentence}${answer || status.trim() ? ` (${status}${answer})` : ''}`
		.replace(/\(\s+/g, '(')
		.replace(/\s+\)/g, ')')
	return [
		head,
		...(projectId ? [`${name} project: ${projectId}`] : []),
		...(requestId ? [`Request ID: ${requestId}`] : []),
	]
}

/** Add what is unknown about usage to the details a failure already carries. */
export function withUnknownUsage(failures: readonly FriendlyFailure[]): FriendlyFailure[] {
	if (failures.length === 0) return []
	const sentence = unknownUsageDetail()
	return failures.map((failure, index) =>
		index === failures.length - 1
			? {
					...failure,
					details: failure.details ? `${failure.details}\n${sentence}` : sentence,
				}
			: failure,
	)
}

function withDetails(failure: Omit<FriendlyFailure, 'details'>, raw: string): FriendlyFailure {
	const details = plainProviderDetails(raw)
		.map((line) => sanitizeDetails(line))
		.filter(Boolean)
		.join('\n')
	return details ? { ...failure, details } : failure
}

/** One failed reply, as the runtime worded it. */
export function describeFailure(raw: string, providerLabel?: string): FriendlyFailure {
	const message = raw.trim()
	const matched = PROVIDER_FAILURE.exec(message)
	if (matched) {
		const name = providerName(matched[1]?.toLowerCase(), providerLabel)
		const sentence = (matched[3] ?? '').toLowerCase()
		const status = matched[2] ? Number(matched[2]) : undefined
		const body = matched[4] ?? ''
		if (sentence.includes('could not reach')) {
			if (status === 408 || /time[ds]? ?out/i.test(body))
				return withDetails(
					{
						kind: 'timeout',
						text: `${name} took too long to answer. Try again.`,
						actions: ['try-again'],
					},
					message,
				)
			return withDetails(
				{
					kind: 'connection',
					text: `Namzu couldn’t reach ${name}. Check your internet connection.`,
					actions: ['try-again'],
				},
				message,
			)
		}
		if (sentence.includes('rejected the request credentials')) {
			const model = MODEL_ACCESS.exec(body)
			if (model || (status === 403 && /\bmodel\b/i.test(body) && !KEY_PROBLEM.test(body)))
				return withDetails(
					{
						kind: 'model-access',
						text: `Your ${name} account can’t use ${model?.[1] ?? 'this model'}. Choose another model.`,
						actions: ['settings'],
					},
					message,
				)
			return withDetails(
				{
					kind: 'rejected-key',
					text: `${name} didn’t accept your key. Check it in Settings, then send again.`,
					actions: ['settings'],
				},
				message,
			)
		}
		if (sentence.includes('rate limited')) {
			if (OUT_OF_CREDIT.test(body))
				return withDetails(
					{
						kind: 'out-of-credit',
						text: `Your ${name} account is out of credit. Add credit in your ${name} billing page, then send again.`,
						actions: ['settings'],
					},
					message,
				)
			return withDetails(
				{
					kind: 'rate-limit',
					text: `${name} asked Namzu to slow down. Give it a minute.`,
					actions: ['try-again'],
				},
				message,
			)
		}
		if (sentence.includes('failed to complete'))
			return withDetails(
				{
					kind: 'server',
					text: `${name} had a problem on its side. Your message is saved.`,
					actions: ['try-again'],
				},
				message,
			)
		if (sentence.includes('context window'))
			return withDetails(
				{
					kind: 'too-long',
					text: 'This conversation is too long for the model. Start a new conversation, or choose a model with more room.',
					actions: ['new-conversation'],
				},
				message,
			)
		if (sentence.includes('rejected the request as invalid')) {
			if (status === 404)
				return withDetails(
					{
						kind: 'model-missing',
						text: `${name} doesn’t offer that model to your account. Choose another model.`,
						actions: ['settings'],
					},
					message,
				)
			if (status === 413)
				return withDetails(
					{
						kind: 'too-large',
						text: `This message is too large for ${name}. Shorten it or remove an attachment, then send again.`,
						actions: [],
					},
					message,
				)
			return withDetails(
				{
					kind: 'rejected-request',
					text: `${name} couldn’t handle this request. Try a different model.`,
					actions: ['settings', 'try-again'],
				},
				message,
			)
		}
	}
	if (/without (?:reporting )?token usage|budget reservation/i.test(message))
		return {
			kind: 'bad-reply',
			text: `${providerLabel ? providerName(undefined, providerLabel) : 'The provider'} sent a reply Namzu couldn’t read. Try again.`,
			actions: ['try-again'],
			details: UNKNOWN_USAGE_DETAIL,
		}
	if (
		/no (?:api )?(?:key|credential)|requires a credential|not configured|set it up in namzu/i.test(
			message,
		)
	)
		return withDetails(
			{
				kind: 'missing-key',
				text: `There is no API key for ${providerName(undefined, providerLabel)}. Add one in Settings, then send again.`,
				actions: ['settings'],
			},
			message,
		)
	if (
		/connection (?:to namzu )?closed|not connected|did not answer|reopen (?:this|the) project/i.test(
			message,
		)
	)
		return withDetails(
			{
				kind: 'lost-connection',
				text: 'Namzu lost its connection and is reconnecting. Your conversation is safe.',
				actions: ['try-again'],
			},
			message,
		)
	return withDetails(
		{
			kind: 'other',
			text: 'Something went wrong and this reply could not finish. Your message is saved. Try again.',
			actions: ['try-again'],
		},
		message,
	)
}

/**
 * The runtime refuses to repeat a stopped reply when it cannot prove what it cost. Those notices
 * speak of receipts, accounting and checkpoints; the person needs to know their message is safe
 * and what to do instead.
 */
export function describeBlockedRetry(notice: string): FriendlyFailure {
	if (/wait for this conversation.s active turn to settle/i.test(notice))
		return {
			kind: 'busy',
			text: 'Namzu is still finishing the last reply. Give it a moment.',
			actions: [],
		}
	if (/recorded human decision|recorded decision/i.test(notice))
		return {
			kind: 'busy',
			text: 'This reply is waiting for a decision before it can go on.',
			actions: [],
		}
	// Every other refusal is about usage Namzu cannot account for; the way on is the same.
	const unknown = /unresolved token usage|actual provider usage receipt/i.test(notice)
	if (/allowance is exhausted/i.test(notice))
		return {
			kind: 'cannot-repeat',
			text: 'This reply used up everything it was allowed, so Namzu can’t repeat it. Continue without this reply to put your message back in the message box and keep working here.',
			actions: ['continue'],
		}
	if (unknown)
		return {
			kind: 'cannot-repeat',
			text: 'Namzu can’t repeat this reply, because this conversation has a limit and it can’t tell how much the provider counted before it stopped. Continue without this reply to put your message back in the message box and keep working here.',
			actions: ['continue'],
			details: UNKNOWN_USAGE_DETAIL,
		}
	return {
		kind: 'cannot-repeat',
		text: 'Namzu can’t repeat this reply. Continue without this reply to put your message back in the message box and keep working here.',
		actions: ['continue'],
	}
}

/** Seconds left in a provider's requested wait, rounded up so it never reads 0 while time remains. */
export function waitSeconds(wait: { at: number; delayMs: number }, now: number): number {
	return Math.max(0, Math.ceil((wait.at + wait.delayMs - now) / 1000))
}

/**
 * The line shown while the provider makes Namzu wait, so a long pause never reads as a hang. It
 * names the provider and the time left; the count changes every second, so it is drawn but not
 * announced each time.
 */
export function providerWaitText(
	wait: { at: number; delayMs: number; throttled: boolean },
	now: number,
	name: string,
): string {
	const seconds = waitSeconds(wait, now)
	const tail = seconds > 0 ? `retrying in ${seconds}s` : 'retrying now'
	return wait.throttled
		? `Waiting for ${name} to accept more requests… ${tail}`
		: `Couldn’t get an answer from ${name}… ${tail}`
}

/** The one line shown when the connection to Namzu dropped, for as long as it is true. */
export function lostConnectionText(project: { reconnecting?: boolean }): string {
	return project.reconnecting
		? 'Namzu lost its connection. Reconnecting…'
		: 'Namzu couldn’t reconnect. Your conversation is safe. Choose Reconnect to try again.'
}

/**
 * An external engine that would not start, in words a person can act on. The engine's
 * own message is about a pipe or a protocol; the cause a person can fix is that it is not
 * installed, not signed in, or not working.
 */
export function describeEngineFailure(raw: string, engineName: string): string | undefined {
	if (
		/engine connection closed|engine (?:process )?(?:exited|stopped)|app-server|spawn .*ENOENT|command not found|not (?:found|installed)|did not answer|connection closed/i.test(
			raw,
		)
	)
		return `${engineName} could not start. Check that it is installed on this computer and that you are signed in to it, then choose Retry setup.`
	return undefined
}
