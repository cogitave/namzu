/**
 * What may become automatic memory.
 *
 * The session promoter turns the claims a turn's working state holds into a
 * stored record. Left alone it keeps the first user message as the record's
 * title, every later user message verbatim, search patterns and raw tool
 * errors. A record like that is recalled into a later turn as if it were a
 * standing instruction, and it can carry a secret or text that reads as an
 * instruction to the model. This screen is the deterministic floor: only a
 * durable statement of how the person wants to work survives, nothing a
 * secret or an injected instruction looks like survives, and what the turn
 * did is described neutrally instead of quoted.
 *
 * Nothing here logs claim text. Counts and reason codes are all a caller gets.
 */

import { type SecretShape, findSecretShape } from '@namzu/sdk'
import type { Logger, PromoteMemory, SessionMemoryCandidate } from '@namzu/sdk'

export type ScreenReason =
	| 'not_durable'
	| 'too_long'
	| 'question'
	| 'request'
	| 'search_trace'
	| 'raw_error'
	| 'secret'
	| 'injection'

/** The longest statement kept as a standing preference. */
export const MAX_REQUIREMENT_CHARS = 240

const BEFORE = String.raw`(?<![\p{L}\p{N}_])`
const AFTER = String.raw`(?![\p{L}\p{N}_])`
const word = (alternatives: string): RegExp =>
	new RegExp(`${BEFORE}(?:${alternatives})${AFTER}`, 'iu')
const APOS = `['’]`

/** Permanent in themselves: "always", "never", "from now on". */
const STRONG_CUE = word(
	[
		'always',
		'never',
		'from now on',
		'going forward',
		'in future',
		`don${APOS}?t`,
		'do not',
		'stop using',
		'her zaman',
		'asla',
		'bundan sonra',
		'bir daha',
		'kullanma',
		'yapma',
		'etme',
	].join('|'),
)

/** A preference or constraint, but also how a one-off request is phrased. */
const WEAK_CUE = word(
	[
		'prefer(?:s|red)?',
		`must(?: not|n${APOS}t)?`,
		`should(?: not|n${APOS}t)?`,
		'avoid',
		'only use',
		'tercih',
		'hep',
		'olmal[ıi]',
		'olmamal[ıi]',
		'gerekir',
		'ka[cç][ıi]n',
	].join('|'),
)

/** The opening of a request to do something now. */
const REQUEST_OPENER =
	/^\s*(?:(?:hey|hi|ok|okay|so|and|now|then)[\s,]+)*(?:please|can you|could you|would you|will you|i want you to|i need you to|i would like you to|let'?s|lütfen|bana|şunu|bunu|yapar m[ıi]s[ıi]n|eder misin|istiyorum)(?![\p{L}])/iu

const QUESTION = /\?/

const INJECTION: readonly RegExp[] = [
	/(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|prompts?|messages?|rules?|context)/i,
	/(?:önceki|yukar[ıi]daki)\s+(?:talimatlar[ıi]|komutlar[ıi]|y[öo]nergeleri)\s+(?:yoksay|unut|dikkate alma)/i,
	/(?:^|\n)\s*(?:system|assistant|developer|human|user)\s*:/i,
	/<\/?\s*(?:system|assistant|developer|tool_calls?|tool_use|tool_result|function_calls?|invoke|instructions?|im_start|im_end)\b[^>]*>/i,
	/<\/?[\w-]*untrusted[\w-]*[^>]*>/i,
	/<\|[a-z_]+\|>/i,
	/\[\/?(?:INST|SYS|SYSTEM)\]/,
	/["']?(?:tool_calls?|function_call)["']?\s*:\s*[[{]/i,
	/(?:you are now|new instructions?|your new (?:role|task))\b/i,
]

function injection(text: string): boolean {
	return INJECTION.some((pattern) => pattern.test(text))
}

/** The reason `text` may not be stored in any category, or `undefined`. */
export function contentReason(text: string): 'secret' | 'injection' | undefined {
	if (findSecretShape(text, { entropy: true }) !== undefined) return 'secret'
	if (injection(text)) return 'injection'
	return undefined
}

/** The shape of the secret `text` holds, for a caller that names it. */
export function secretShapeOf(text: string): SecretShape | undefined {
	return findSecretShape(text, { entropy: true })
}

function requirementReason(text: string): ScreenReason | undefined {
	if (text.length > MAX_REQUIREMENT_CHARS) return 'too_long'
	if (QUESTION.test(text)) return 'question'
	const strong = STRONG_CUE.test(text)
	if (!strong && !WEAK_CUE.test(text)) return 'not_durable'
	if (!strong && REQUEST_OPENER.test(text)) return 'request'
	return undefined
}

/** Why one claim of `category` is not kept, or `undefined` when it is. */
export function claimReason(
	category: 'userRequirements' | 'decisions' | 'discoveries' | 'failures' | 'environment',
	text: string,
): ScreenReason | undefined {
	if (category === 'failures') return 'raw_error'
	if (category === 'discoveries' && /^\s*searched\s*:/i.test(text)) return 'search_trace'
	const content = contentReason(text)
	if (content !== undefined) return content
	if (category === 'userRequirements') return requirementReason(text)
	return undefined
}

export interface ScreenedCandidate {
	readonly candidate: SessionMemoryCandidate
	/** Claims dropped, by reason. No text. */
	readonly dropped: Readonly<Partial<Record<ScreenReason, number>>>
}

const CATEGORIES = [
	'userRequirements',
	'decisions',
	'discoveries',
	'failures',
	'environment',
] as const

/** The neutral title: what the turn touched, never what it was asked. */
function neutralTitle(files: readonly string[]): string {
	const names = [
		...new Set(
			files
				.map((file) => file.split(/[\\/]/).pop() ?? '')
				.filter((name) => name !== '' && contentReason(name) === undefined),
		),
	]
	if (names.length === 0) return 'Session notes'
	const shown = names.slice(0, 3).join(', ')
	return names.length > 3
		? `Session notes: ${shown} and ${names.length - 3} more`
		: `Session notes: ${shown}`
}

/** Apply every rule to a candidate. Pure. */
export function screenCandidate(candidate: SessionMemoryCandidate): ScreenedCandidate {
	const dropped: Partial<Record<ScreenReason, number>> = {}
	const kept: Record<(typeof CATEGORIES)[number], string[]> = {
		userRequirements: [],
		decisions: [],
		discoveries: [],
		failures: [],
		environment: [],
	}
	for (const category of CATEGORIES) {
		for (const text of candidate[category]) {
			const reason = claimReason(category, text)
			if (reason === undefined) kept[category].push(text)
			else dropped[reason] = (dropped[reason] ?? 0) + 1
		}
	}
	const files = candidate.files.filter((file) => contentReason(file) === undefined)
	return {
		candidate: { ...candidate, ...kept, task: neutralTitle(files), files },
		dropped,
	}
}

/** The promoter behind the screen: logs counts, never text. */
export function screenMemoryPromotion(promote: PromoteMemory, log: Logger): PromoteMemory {
	return (candidate) => {
		const { candidate: screened, dropped } = screenCandidate(candidate)
		for (const [reason, count] of Object.entries(dropped)) {
			log.info('memory claims dropped', {
				'namzu.memory.screen.reason': reason,
				'namzu.memory.screen.dropped_count': count,
			})
		}
		return promote(screened)
	}
}
