/**
 * Which composer triggers a draft names, and in what state.
 *
 * Pure and local: no model call, no clock, no file. The Composer calls it on
 * every render (memoised) and once more at submit.
 *
 * A match is **strict** when it stands where a request stands:
 * - a keyword is the first or last word of its clause;
 * - an English phrase starts and ends at clause edges (a conjunction such as
 *   `and`, `then`, `ve`, `sonra` counts as an edge); a Turkish phrase, whose
 *   verb comes last, has to end at one;
 * - in a clause that ends with `?`, a match is strict only with a request
 *   frame: `please`, `can/could/would/will you`, or a polite Turkish form
 *   (`kaydeder misin`, `kaydedebilir misin`, `kaydedelim mi`) — so "how do I
 *   … and save it as a skill?" and "what is hypermode?" are talk, not asks;
 * - a phrase followed by `:` is a label ("skill olarak kaydet: bu ne?");
 * - an English negation (`not`, `don't`, `never`, `no`, `without`, …) up to
 *   three words before a match in its clause cancels it, except `don't forget`;
 * - a keyword next to a word about words (`keyword`, `mode`, `kelimesi`, …)
 *   is being talked about.
 *
 * A strict match of a trigger whose arming is `arm`, made only of characters
 * the operator typed here, is **armed**. Everything else that matches is a
 * **suggestion**: offered in the tag row, armed only with Alt+W. Nothing in
 * code, quotes, URLs, paths, mentions or `>` lines matches at all, and a draft
 * that starts with `/`, `!` or `#` is a command, never scanned.
 */

import { type Analysis, analyze, inZone } from './analyze.js'
import { FORM_OPTATIVE, FORM_POLITE, type MatchStats, matchAt } from './pattern.js'
import type { CompiledTrigger, TriggerId, TriggerRegistry } from './registry.js'
import { QUESTION_PARTICLES } from './verbs.js'

/** Past this many UTF-16 code units a draft is not scanned; the row says so. */
export const MAX_SCANNED_DRAFT = 65_536

export type TriggerState = 'armed' | 'suggested' | 'dropped' | 'unavailable'

export interface TriggerHit {
	readonly id: TriggerId
	readonly label: string
	/** Draft offsets of the words that named it. */
	readonly start: number
	readonly end: number
	readonly state: TriggerState
	/** Why it cannot apply now, for `unavailable`. */
	readonly reason?: string
	readonly scope: 'turn' | 'after-turn'
	/** Identifies this hit for Alt+W: the trigger and where its words start. */
	readonly key: string
}

export interface Detection {
	/** One hit per trigger, in draft order. */
	readonly hits: readonly TriggerHit[]
	/** The draft is nothing but armed triggers and filler words (`please`, `bunu`, …). */
	readonly onlyTriggers: boolean
	/** Set when the draft was too long to scan. */
	readonly paused?: 'too-long'
}

/** What the session is like right now, for availability. */
export interface TriggerContext {
	readonly permissionMode: string
	/** Hypermode is already on for the session. */
	readonly sessionHypermode: boolean
	/** The model publishes an exact effort menu. */
	readonly effortMenu: boolean
	/** The session can delegate (`Agent` is not withheld). */
	readonly agentTool: boolean
	/** The `skill-creator` skill is usable by the model. */
	readonly skillCreator: boolean
	/** The `schedule` tool is mounted. */
	readonly scheduleTool: boolean
}

export interface DetectOptions {
	/** Draft ranges that were not typed key by key here (pasted, recalled, …). */
	readonly nonTyped?: readonly (readonly [number, number])[]
	/** Alt+W decisions, by hit key. */
	readonly overrides?: ReadonlyMap<string, 'dropped' | 'armed'>
	/** Show suggestions. `false` hides every hit that is not armed by text or by hand. */
	readonly suggest?: boolean
	readonly stats?: MatchStats
}

export const EMPTY_DETECTION: Detection = { hits: [], onlyTriggers: false }

const CONJUNCTIONS = new Set(['and', 'then', 'also', 've', 'sonra', 'ardindan', 'ayrica'])
const NEGATIONS = new Set([
	'not',
	"don't",
	'dont',
	'never',
	'no',
	'without',
	"doesn't",
	"didn't",
	"shouldn't",
	"won't",
])
/** Words that mark the next or previous word as the thing being talked about. */
const META_WORDS = new Set([
	'keyword',
	'word',
	'mode',
	'command',
	'feature',
	'setting',
	'flag',
	'trigger',
	'option',
])
const META_PREFIXES = ['kelime', 'modu', 'komut', 'ozellig', 'ayar', 'secenek', 'sozcuk']
const FILLERS = new Set([
	'please',
	'lutfen',
	'now',
	'simdi',
	'this',
	'bunu',
	'ok',
	'okay',
	'tamam',
	'and',
	've',
])
const REQUEST_VERBS = new Set(['can', 'could', 'would', 'will'])

/** Whether a draft is a command the triggers never read: `/…`, `!…`, `#…`. */
export function isCommandDraft(draft: string): boolean {
	return /^[/!#]/u.test(draft.trimStart())
}

export function detectTriggers(
	draft: string,
	registry: TriggerRegistry,
	context: TriggerContext,
	options: DetectOptions = {},
): Detection {
	if (registry.triggers.length === 0 || isCommandDraft(draft) || draft.trim().length === 0)
		return EMPTY_DETECTION
	if (draft.length > MAX_SCANNED_DRAFT) return { hits: [], onlyTriggers: false, paused: 'too-long' }
	const analysis = analyze(draft)
	const words = analysis.tokens.map((token) => token.text)
	const hits: TriggerHit[] = []
	const armedTokens = new Set<number>()
	for (const trigger of registry.triggers) {
		const found = bestCandidate(trigger, analysis, words, options.stats)
		if (!found) continue
		const start = analysis.tokens[found.first]?.start ?? 0
		const end = analysis.tokens[found.last]?.end ?? start
		const key = `${trigger.definition.id}@${start}`
		const typed = !(options.nonTyped ?? []).some(([from, to]) => start < to && end > from)
		const byText = found.strict && trigger.arming === 'arm' && typed
		const override = options.overrides?.get(key)
		let state: TriggerState =
			override === 'dropped' && byText
				? 'dropped'
				: override === 'armed' || (byText && override !== 'dropped')
					? 'armed'
					: 'suggested'
		const reason = unavailable(trigger.definition.id, context)
		if (reason && state === 'armed') state = 'unavailable'
		if (state === 'suggested' && (reason || options.suggest === false)) continue
		if (state === 'armed')
			for (let index = found.first; index <= found.last; index += 1) armedTokens.add(index)
		hits.push({
			id: trigger.definition.id,
			label: trigger.definition.label,
			start,
			end,
			state,
			...(state === 'unavailable' && reason ? { reason } : {}),
			scope: trigger.definition.scope,
			key,
		})
	}
	hits.sort((a, b) => a.start - b.start)
	const onlyTriggers =
		armedTokens.size > 0 &&
		analysis.tokens.every((token, index) => armedTokens.has(index) || FILLERS.has(token.text))
	return { hits, onlyTriggers }
}

interface Candidate {
	/** Token indices, inclusive. */
	readonly first: number
	readonly last: number
	readonly strict: boolean
}

/** The trigger's first strict match, else its first loose one. */
function bestCandidate(
	trigger: CompiledTrigger,
	analysis: Analysis,
	words: readonly string[],
	stats?: MatchStats,
): Candidate | undefined {
	const candidates: Candidate[] = []
	const { tokens } = analysis
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]
		if (!token || token.excluded) continue
		if (trigger.keywords.has(token.text)) {
			candidates.push({ first: index, last: index, strict: keywordIsStrict(analysis, index) })
		}
		for (const phrase of trigger.phrases) {
			const match = matchAt(phrase.pattern, words, index, stats)[0]
			if (!match) continue
			const first = match.start
			const last = match.end - 1
			if (inZone(analysis, tokens[first]?.start ?? 0, tokens[last]?.end ?? 0)) continue
			if (negated(analysis, first)) continue
			candidates.push({
				first,
				last,
				strict: phraseIsStrict(analysis, first, last, phrase.edges, match.flags),
			})
		}
	}
	const strict = candidates.find((candidate) => candidate.strict)
	if (strict) return strict
	if (candidates[0]) return candidates[0]
	return looseCandidate(trigger, analysis)
}

function looseCandidate(trigger: CompiledTrigger, analysis: Analysis): Candidate | undefined {
	for (const clause of analysis.clauses) {
		for (const loose of trigger.loose) {
			let first = Number.POSITIVE_INFINITY
			let last = -1
			const satisfied = loose.slots.every((slot) => {
				for (let index = clause.first; index <= clause.last; index += 1) {
					const token = analysis.tokens[index]
					if (!token || token.excluded || !slot(token.text)) continue
					first = Math.min(first, index)
					last = Math.max(last, index)
					return true
				}
				return false
			})
			if (satisfied && !negated(analysis, first)) return { first, last, strict: false }
		}
	}
	return undefined
}

function isConjunctionBefore(analysis: Analysis, index: number): boolean {
	const previous = analysis.tokens[index - 1]
	if (!previous || previous.edgeAfter) return false
	if (CONJUNCTIONS.has(previous.text)) return true
	// "bir de": "and also".
	return previous.text === 'de' && analysis.tokens[index - 2]?.text === 'bir'
}

function isConjunctionAfter(analysis: Analysis, index: number): boolean {
	const next = analysis.tokens[index + 1]
	return next !== undefined && !analysis.tokens[index]?.edgeAfter && CONJUNCTIONS.has(next.text)
}

const leftEdge = (analysis: Analysis, index: number) =>
	(analysis.tokens[index]?.edgeBefore ?? true) || isConjunctionBefore(analysis, index)
const rightEdge = (analysis: Analysis, index: number) =>
	(analysis.tokens[index]?.edgeAfter ?? true) || isConjunctionAfter(analysis, index)

function isMetaWord(text: string | undefined): boolean {
	if (text === undefined) return false
	return META_WORDS.has(text) || META_PREFIXES.some((prefix) => text.startsWith(prefix))
}

function keywordIsStrict(analysis: Analysis, index: number): boolean {
	const token = analysis.tokens[index]
	if (!token) return false
	const first = leftEdge(analysis, index)
	const last = rightEdge(analysis, index)
	if (!first && !last) return false
	// "the hypermode keyword", "hypermode kelimesi": talk about the word.
	const previous = analysis.tokens[index - 1]
	const next = analysis.tokens[index + 1]
	if (
		(!token.edgeBefore && isMetaWord(previous?.text)) ||
		(!token.edgeAfter && isMetaWord(next?.text))
	)
		return false
	const clause = analysis.clauses[token.clause]
	// "what is hypermode?" asks about it; "hypermode, can you split this?"
	// puts it in a clause of its own, and "hypermode ile … yapar mısın?" asks
	// for the work with it.
	if (clause?.question)
		return first && hasRequestFrame(analysis, clause.first, clause.last, 0, clause.last)
	return true
}

function phraseIsStrict(
	analysis: Analysis,
	first: number,
	last: number,
	edges: 'both' | 'right',
	flags: number,
): boolean {
	if (edges === 'both' && !leftEdge(analysis, first)) return false
	if (!rightEdge(analysis, last)) return false
	if (analysis.tokens[last]?.colonAfter) return false
	const clause = analysis.clauses[analysis.tokens[last]?.clause ?? -1]
	if (clause?.question && !hasRequestFrame(analysis, clause.first, clause.last, flags, last))
		return false
	return true
}

/** `please`, `can/could/would/will you`, or a polite Turkish verb form. */
function hasRequestFrame(
	analysis: Analysis,
	from: number,
	to: number,
	flags: number,
	matchLast: number,
): boolean {
	if (flags & FORM_POLITE) return true
	if (flags & FORM_OPTATIVE && QUESTION_PARTICLES.has(analysis.tokens[matchLast]?.text ?? ''))
		return true
	for (let index = from; index <= to; index += 1) {
		const text = analysis.tokens[index]?.text
		if (text === 'please' || text === 'lutfen') return true
		if (text && REQUEST_VERBS.has(text) && analysis.tokens[index + 1]?.text === 'you') return true
		if (text && /^(misin|misiniz|musun|musunuz)$/u.test(text)) return true
		if (text && /(misin|misiniz|musun|musunuz)$/u.test(text) && text.length > 6) return true
	}
	return false
}

/** An English negation up to three words before `index`, in its clause. */
function negated(analysis: Analysis, index: number): boolean {
	const clause = analysis.tokens[index]?.clause
	for (let at = index - 1; at >= Math.max(0, index - 3); at -= 1) {
		const token = analysis.tokens[at]
		if (!token || token.clause !== clause) break
		if (NEGATIONS.has(token.text) && analysis.tokens[at + 1]?.text !== 'forget') return true
	}
	return false
}

/** Why a trigger cannot apply in this session right now, or undefined when it can. */
export function unavailable(id: TriggerId, context: TriggerContext): string | undefined {
	switch (id) {
		case 'hypermode':
			if (context.sessionHypermode) return 'already on for this session'
			if (!context.agentTool) return 'unavailable: this session cannot delegate'
			return undefined
		case 'save-skill':
			if (context.permissionMode === 'plan' || context.permissionMode === 'strict')
				return `unavailable in ${context.permissionMode} mode`
			if (!context.skillCreator) return 'unavailable: the skill-creator skill is off'
			return undefined
		case 'schedule':
			if (context.permissionMode === 'plan') return 'unavailable in plan mode'
			if (!context.scheduleTool) return 'unavailable in this session'
			return undefined
		case 'max-effort':
			if (!context.effortMenu) return 'unavailable: this model publishes no effort levels'
			return undefined
	}
}
