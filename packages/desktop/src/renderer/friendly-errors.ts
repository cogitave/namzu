/**
 * What a person reads when a reply fails. The runtime's own sentences name internal parts
 * (receipts, accounting, HTTP codes, vendor JSON); this turns them into one plain sentence and a
 * next step, and keeps the original behind a "Details" disclosure. The mapping reads only text, so
 * it can be tested without a window.
 */

export type FailureAction = 'try-again' | 'settings' | 'new-conversation'

export interface FriendlyFailure {
	kind:
		| 'connection'
		| 'rejected-key'
		| 'missing-key'
		| 'rate-limit'
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
		.replace(/\s+/g, ' ')
		.trim()
	return text.length > 500 ? `${text.slice(0, 499)}…` : text
}

const PROVIDER_FAILURE = /^([a-z0-9][a-z0-9-]*)(?: \(HTTP (\d{3})\))? — ([^:]+?)(?:: ([\s\S]*))?$/i

function withDetails(failure: Omit<FriendlyFailure, 'details'>, raw: string): FriendlyFailure {
	const details = sanitizeDetails(raw)
	return details ? { ...failure, details } : failure
}

/** One failed reply, as the runtime worded it. */
export function describeFailure(raw: string, providerLabel?: string): FriendlyFailure {
	const message = raw.trim()
	const matched = PROVIDER_FAILURE.exec(message)
	if (matched) {
		const name = providerName(matched[1]?.toLowerCase(), providerLabel)
		const sentence = (matched[3] ?? '').toLowerCase()
		if (sentence.includes('could not reach'))
			return withDetails(
				{
					kind: 'connection',
					text: `Namzu couldn’t reach ${name}. Check your internet connection, then try again.`,
					actions: ['try-again'],
				},
				message,
			)
		if (sentence.includes('rejected the request credentials'))
			return withDetails(
				{
					kind: 'rejected-key',
					text: `${name} didn’t accept your key. Check it in Settings, then send again.`,
					actions: ['settings'],
				},
				message,
			)
		if (sentence.includes('rate limited'))
			return withDetails(
				{
					kind: 'rate-limit',
					text: `${name} asked Namzu to slow down. Wait a minute, then try again.`,
					actions: ['try-again'],
				},
				message,
			)
		if (sentence.includes('failed to complete'))
			return withDetails(
				{
					kind: 'server',
					text: `${name} had a problem on its side. Your message is saved. Try again in a minute.`,
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
		if (sentence.includes('rejected the request as invalid'))
			return withDetails(
				{
					kind: 'rejected-request',
					text: `${name} couldn’t handle this request. Try a different model.`,
					actions: ['settings', 'try-again'],
				},
				message,
			)
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
			text: 'Something went wrong and this reply could not finish. Your message is saved.',
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
	const details = sanitizeDetails(notice)
	const withOriginal = (failure: Omit<FriendlyFailure, 'details'>): FriendlyFailure =>
		details ? { ...failure, details } : failure
	if (/wait for this conversation.s active turn to settle/i.test(notice))
		return withOriginal({
			kind: 'busy',
			text: 'Namzu is still finishing the last reply. Give it a moment.',
			actions: [],
		})
	if (/allowance is exhausted/i.test(notice))
		return withOriginal({
			kind: 'cannot-repeat',
			text: 'This reply used up everything it was allowed, so Namzu can’t repeat it. Start a new conversation to carry on.',
			actions: ['new-conversation'],
		})
	if (/recorded human decision|recorded decision/i.test(notice))
		return withOriginal({
			kind: 'busy',
			text: 'This reply is waiting for a decision before it can go on.',
			actions: [],
		})
	return withOriginal({
		kind: 'cannot-repeat',
		text: 'Namzu can’t safely repeat this reply, because it can’t tell how much the provider counted before it stopped. Your message is saved above. Start a new conversation to try again.',
		actions: ['new-conversation'],
	})
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
