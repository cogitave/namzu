/**
 * Compare what an answer claims about checks with what the turn's outcome
 * record holds.
 *
 * A pure function: no model call, no clock, no I/O. The model's words only
 * select which statement to check; the statement the kernel then makes is
 * about the record, so it never claims more than the record establishes.
 *
 * It is built to stay silent. A notice that is wrong teaches people to ignore
 * the line, so every doubt resolves to nothing: a negation, a hedge, a
 * condition, a question, a quotation, code, a report of what someone else
 * said, a statement about the past, a qualified claim ("all but one"), and any
 * language but English. The claim wording and the words that cancel it are data
 * below, each with the reason it is there.
 *
 * It looks at the record of THIS turn only. A turn whose record says nothing
 * changed is never reported: "the tests pass" may be true of an earlier turn.
 */

import type {
	AnswerClaimKind,
	AnswerClaimMismatch,
	AnswerClaimRecord,
	TurnOutcome,
} from '../../../types/session/outcome.js'
import { auditCommandText } from './completion-audit.js'

/** Answers longer than this are read only up to it, so cost stays bounded. */
export const ANSWER_CLAIM_MAX_CHARS = 100_000

/** The longest quotation of the answer a mismatch carries, in characters. */
export const ANSWER_CLAIM_MAX_QUOTE_CHARS = 160

/** Words that may sit between a subject and its verb without changing the claim. */
const FILLER =
	'(?:\\s+(?:all|now|also|still|again|both|are|were|is|have|has|been|currently|locally|fully))*'

/** Verbs that say a check came out well. */
const PASSED = '(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)\\b'

/** Determiners and kinds of test that may precede `tests`. */
const TEST_WORDS =
	'(?:(?:all(?:\\s+of)?|the|my|our)\\s+)?(?:(?:unit|integration|e2e|existing|new|relevant|related|automated)\\s+)*'

interface ClaimPattern {
	readonly kind: AnswerClaimKind
	/** The claim in the kernel's words. */
	readonly said: string
	/** Matches the claim inside one clause. */
	readonly re: RegExp
	/** Why this wording, and why it is safe. */
	readonly why: string
}

/**
 * Plain positive claims only. Each pattern needs the subject, at most a few
 * filler words, and the verb, in that order, so a negation or a modal between
 * them ("did not", "should") breaks the match by itself.
 */
export const ANSWER_CLAIM_PATTERNS: readonly ClaimPattern[] = [
	{
		kind: 'tests',
		said: 'the tests pass',
		re: new RegExp(`\\b${TEST_WORDS}tests\\b${FILLER}\\s+${PASSED}`, 'i'),
		why: 'The plural "tests" as the subject. The singular is left out: "the test now passes" is usually about the one test just fixed, which says nothing about the run that failed.',
	},
	{
		kind: 'tests',
		said: 'the test suite passes',
		re: new RegExp(
			`\\b(?:test\\s+suite|the\\s+suite|(?:whole|full|entire)\\s+(?:test\\s+)?suite|test\\s+run)\\b${FILLER}\\s+${PASSED}`,
			'i',
		),
		why: 'The suite as a whole is the same claim as "the tests pass", also as "the whole suite". A bare "suite" is not enough: it also names a benchmark suite or a suite of rooms.',
	},
	{
		kind: 'tests',
		said: 'no test failures',
		re: /\b(?:no|zero|0)\s+(?:test\s+failures|failing\s+tests|failed\s+tests|test\s+errors)\b/i,
		why: 'The same claim said by counting failures. It is matched whole, so the word "no" in it is not read as a negation.',
	},
	{
		kind: 'tests',
		said: 'no test failures',
		re: /\b(?:no\s+tests?\s+(?:are\s+|is\s+)?(?:fail(?:s|ing|ed)?)|tests?\s+(?:are\s+not|aren['\u2019]t|do\s+not|don['\u2019]t|did\s+not|didn['\u2019]t)\s+(?:fail|failing))\b/i,
		why: 'The same claim said as a negated failure: "no tests are failing", "the tests do not fail". The pattern holds its own negation, and the failure word in it is not read as a failure.',
	},
	{
		kind: 'tests',
		said: 'the tests pass',
		re: /\b(?:ran|run|running)\s+(?:(?:all\s+)?(?:of\s+)?(?:the|my|our)\s+)?(?:\w+\s+){0,2}(?:tests|test\s+suite|suite)\s+and\s+(?:they|it)\s+(?:all\s+)?(?:pass(?:es|ed)?|are\s+(?:green|passing))\b/i,
		why: 'The pronoun form, the commonest plain phrasing: "I ran the tests and they all pass". The run and its result are in one clause, and a negation between them ("they did not pass") breaks the match.',
	},
	{
		kind: 'checks',
		said: 'the checks pass',
		re: /^\W*(?:it['\u2019]?s\s+|it\s+is\s+|everything\s+is\s+)?all\s+green\b/i,
		why: 'The shortest summary: "All green." Anchored to the start of the sentence, so "not all green" never matches.',
	},
	{
		kind: 'build',
		said: 'the build succeeds',
		re: /\b(?:it|everything)\s+compiles\b/i,
		why: 'A bare "it compiles". The pronoun or "everything" is required: "the compiles list" and similar nouns are not claims.',
	},
	{
		kind: 'build',
		said: 'the build succeeds',
		re: new RegExp(
			`\\b(?:build|compilation|compile)\\b${FILLER}\\s+(?:succeed(?:s|ed)?|pass(?:es|ed)?|green|completes?|completed|works|worked|is\\s+clean)\\b`,
			'i',
		),
		why: 'The build as the subject with a success verb. "The build" alone, as in "the build script", never matches because the verb must follow.',
	},
	{
		kind: 'build',
		said: 'the build succeeds',
		re: /\b(?:builds?|compiles?)\s+(?:cleanly|successfully|fine)\b/i,
		why: 'The adverb form: "it builds cleanly", "everything compiles successfully".',
	},
	{
		kind: 'lint',
		said: 'lint is clean',
		re: new RegExp(
			`\\blint(?:ing|er)?\\b${FILLER}\\s+(?:is\\s+|are\\s+)?(?:clean|pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|ok)\\b`,
			'i',
		),
		why: 'Lint as the subject with a clean or passing verb.',
	},
	{
		kind: 'lint',
		said: 'lint is clean',
		re: /\bno\s+lint(?:ing)?\s+(?:errors?|warnings?|issues?|problems?)\b/i,
		why: 'The same claim by counting: "no lint errors". Matched whole, so its own "no" is not a negation.',
	},
	{
		kind: 'typecheck',
		said: 'type checking passes',
		re: new RegExp(
			`\\b(?:type[\\s-]?check(?:ing|s)?|typecheck|tsc)\\b${FILLER}\\s+(?:is\\s+|are\\s+)?(?:clean|pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|ok)\\b`,
			'i',
		),
		why: 'Type checking, the one-word spelling and the compiler named for it, as the subject. "Type checker" is left out: "the type checker passes the argument on" names what a checker does, not a result.',
	},
	{
		kind: 'typecheck',
		said: 'type checking passes',
		re: /\bno\s+type\s+errors\b/i,
		why: 'The same claim by counting: "no type errors".',
	},
	{
		kind: 'checks',
		said: 'the checks pass',
		re: new RegExp(
			`\\b(?:all\\s+(?:of\\s+)?(?:the\\s+)?checks|the\\s+(?:ci\\s+)?checks|ci\\s+checks|everything)\\b${FILLER}\\s+${PASSED}`,
			'i',
		),
		why: 'The catch-all a summary reaches for: "all checks pass", "the CI checks pass", "everything is green".',
	},
	{
		kind: 'tests',
		said: 'the tests pass',
		re: /^\W*(?:\*\*)?(?:tests?|test\s+suite)(?:\*\*)?\s*[:\-\u2013]\s*(?:\*\*)?\s*(?:all\s+)?(?:\d+\s+)?(?:pass(?:es|ed|ing)?|green|success(?:ful)?|ok|\u2705|\u2714)/i,
		why: 'The label form of a summary list: "Tests: passing". Anchored to the start of the line, where a label stands.',
	},
	{
		kind: 'build',
		said: 'the build succeeds',
		re: /^\W*(?:\*\*)?build(?:\*\*)?\s*[:\-–]\s*(?:\*\*)?\s*(?:pass(?:es|ed|ing)?|green|success(?:ful)?|ok|clean|✅|✔)/i,
		why: 'The label form: "Build: success".',
	},
	{
		kind: 'lint',
		said: 'lint is clean',
		re: /^\W*(?:\*\*)?lint(?:ing)?(?:\*\*)?\s*[:\-–]\s*(?:\*\*)?\s*(?:pass(?:es|ed|ing)?|green|success(?:ful)?|ok|clean|✅|✔)/i,
		why: 'The label form: "Lint: clean".',
	},
	{
		kind: 'typecheck',
		said: 'type checking passes',
		re: /^\W*(?:\*\*)?(?:type[\s-]?check(?:ing)?|typecheck)(?:\*\*)?\s*[:\-–]\s*(?:\*\*)?\s*(?:pass(?:es|ed|ing)?|green|success(?:ful)?|ok|clean|✅|✔)/i,
		why: 'The label form: "Typecheck: passing".',
	},
]

/** Words that turn the claim around. Looked for in the few words before it. */
const NEGATION =
	/\b(?:not|no|never|none|nothing|nobody|zero|scarcely|neither|nor|cannot|unable|without|barely|hardly|n't|isn|aren|doesn|don|didn|wasn|weren|won|couldn|can't|won't)\b|n['’]t\b/i

/** Words that make it a wish, a plan, a condition, a request or a guess. Looked for in the few words before it. */
const HEDGE =
	/\b(?:if|once|when|whenever|unless|until|assuming|provided|whether|in\s+case|so\s+that|ensure|ensures|ensuring|make\s+sure|makes\s+sure|make|makes|get|gets|keep|keeps|verify|verifying|confirm|confirming|check\s+(?:that|whether)|hope|hopes|hoping|hopefully|expect|expects|expecting|expected|want|wants|need|needs|must|should|would|could|might|may|can|will|probably|likely|maybe|perhaps|presumably|supposedly|apparently|ideally|seems?|appears?|think|believe|assume|guess|suppose|imagine|wonder|let|try|please|goal|aim|aims|target)\b|'ll\b/i

/** Words that report what someone or something else said. Looked for in the whole clause. */
const REPORTING =
	/\b(?:said|says|say|saying|claims?|claimed|claiming|reports?|reported|reporting|according\s+to|states?|stated|mentions?|mentioned|noted|told|tells|asked|asks|promises?|promised|advertises?|advertised)\b/i

/** Words that put the claim in the past, before this turn's change. Looked for in the whole clause. */
const EARLIER =
	/\b(?:before|earlier|previously|prior|originally|beforehand|initially|yesterday|formerly|used\s+to|at\s+first|last\s+time|last\s+week|until\s+now|in\s+the\s+past|back\s+then|had\s+been)\b/i

/**
 * Words that make the claim partial, a guess or someone else's. Looked for in
 * the few words after it. The last few are the plain negation of other languages
 * ("değil", "nicht", "pas") for a clause that holds an English claim.
 */
const QUALIFIER =
	/\b(?:except|besides|apart|aside|other\s+than|but\s+for|barring|mostly|partly|partially|mainly|almost|nearly|only|if|unless|provided|once|when|until|assuming|so\s+far\s+as|aside\s+from|on\s+ci|in\s+theory|apparently|supposedly|allegedly|presumably|seemingly|reportedly|hopefully|probably|maybe|perhaps|goal|aim|target|de[g\u011f]il|nicht|nein|pas)\b/i

/** A failure named anywhere else in the sentence: the sentence is reporting one, not claiming a pass. */
const FAILURE =
	/\b(?:fail|fails|failed|failing|failure|failures|error|errors|broken|breaks|red|regress(?:ed|es|ion)?)\b/i

/**
 * A word anywhere in the sentence that makes every claim in it a guess, or a
 * claim in another language's negation. It sits at sentence level because a
 * comma often separates it from the claim: "The tests pass, apparently."
 */
const SENTENCE_HEDGE =
	/\b(?:apparently|supposedly|allegedly|presumably|seemingly|reportedly|hopefully|probably|maybe|perhaps|de[g\u011f]il|nicht|nein)\b/i

/** Words a sentence may start with that make everything after it conditional. */
const CONDITIONAL_START =
	/^\W*(?:if|once|when|whenever|unless|assuming|provided|in\s+case|should|were|had)\b/i

/** How many words before and after a claim are read for what cancels it. */
const WORDS_BEFORE = 6
const WORDS_AFTER = 6

/** What a verb that takes an object starts with: "the type checker passes the argument on" is not a result. */
const OBJECT_AFTER =
	/^\W*(?:the|a|an|its|their|his|her|them|it|this|that|these|those|each|every|any|some|through|along)\b/i

/** A claim worded as a subject ("tests passing is the goal"): the verb is a gerund that a copula follows. */
const COPULA_AFTER = /^\W*(?:is|are|was|were|means|requires|needs)\b/i

/** What is left of an answer once the places a claim does not count are taken out. */
function readableText(answer: string): string {
	return (
		answer
			.slice(0, ANSWER_CLAIM_MAX_CHARS)
			// A fenced block, or one the answer never closed.
			.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, ' _ ')
			// A block quotation: its lines are somebody else's words.
			.replace(/^[ \t]*>.*$/gm, ' ')
			// An inline code span names a command or a symbol, not a claim.
			.replace(/`[^`\n]{0,400}`/g, ' _ ')
			// A quotation in either kind of double quotes.
			.replace(/"[^"\n]{0,400}"/g, ' _ ')
			.replace(/“[^”\n]{0,400}”/g, ' _ ')
	)
}

/** Sentences, and within one the clauses a claim and its hedge do not cross. */
function clausesOf(text: string): { sentenceEndsWithQuestion: boolean; clauses: string[] }[] {
	const out: { sentenceEndsWithQuestion: boolean; clauses: string[] }[] = []
	// A semicolon ends a statement, so a failure named in one half does not cancel a claim in the other.
	for (const raw of text.split(/(?<=[.!?])\s+|\n+|;\s*/)) {
		const sentence = raw.trim()
		if (sentence === '') continue
		if (CONDITIONAL_START.test(sentence) || SENTENCE_HEDGE.test(sentence)) continue
		// What the claim patterns themselves match ("no test failures") is not a failure.
		let rest = sentence
		for (const pattern of ANSWER_CLAIM_PATTERNS) {
			rest = rest.replace(new RegExp(pattern.re.source, 'gi'), ' ')
		}
		// "no errors", "without failures": a count of none is not a failure.
		rest = rest.replace(/\b(?:no|zero|0|without)\s+(?:\w+\s+)?(?:errors?|failures?)\b/gi, ' ')
		if (FAILURE.test(rest)) continue
		out.push({
			sentenceEndsWithQuestion: /\?\W*$/.test(sentence),
			// A comma, a semicolon, a dash, a bracket, or a word that turns the sentence around.
			clauses: sentence.split(
				/[,;()—]|\s-\s|\s–\s|\b(?:but|however|although|though|while|whereas|yet|because|since|so)\b/i,
			),
		})
	}
	return out
}

function wordsBefore(clause: string, at: number): string {
	return clause.slice(0, at).trim().split(/\s+/).slice(-WORDS_BEFORE).join(' ')
}

function wordsAfter(clause: string, to: number): string {
	return clause.slice(to).trim().split(/\s+/).slice(0, WORDS_AFTER).join(' ')
}

/** The claim in this clause, when it is a plain, present, positive one. */
function claimIn(clause: string): ClaimPattern | undefined {
	if (REPORTING.test(clause) || EARLIER.test(clause)) return undefined
	for (const pattern of ANSWER_CLAIM_PATTERNS) {
		const found = pattern.re.exec(clause)
		if (!found) continue
		const before = wordsBefore(clause, found.index)
		if (NEGATION.test(before) || HEDGE.test(before)) continue
		const after = wordsAfter(clause, found.index + found[0].length)
		if (QUALIFIER.test(after)) continue
		if (/\bpass(?:es)?$/i.test(found[0]) && OBJECT_AFTER.test(after)) continue
		if (/\bpassing$/i.test(found[0]) && COPULA_AFTER.test(after)) continue
		if (/\d+\s+of\s+\d+/.test(clause)) continue
		return pattern
	}
	return undefined
}

/** The kind of check a command line is, when it says so. */
const COMMAND_KINDS: readonly { kind: AnswerClaimKind; re: RegExp }[] = [
	{
		kind: 'lint',
		re: /\b(?:lint|eslint|biome|prettier|ruff|flake8|rubocop|clippy|golangci-lint)\b/i,
	},
	{ kind: 'typecheck', re: /\b(?:typecheck|tsc|mypy|pyright)\b/i },
	{ kind: 'tests', re: /\b(?:test|tests|vitest|jest|pytest|mocha|phpunit|spec)\b/i },
	{ kind: 'build', re: /\b(?:build|compile|bundle)\b/i },
]

/** A type check is a compile, so a claim about either is about both. */
function sameKind(a: AnswerClaimKind, b: AnswerClaimKind): boolean {
	if (a === b) return true
	return (a === 'build' && b === 'typecheck') || (a === 'typecheck' && b === 'build')
}

/** Every kind a command line is: a chained `pnpm lint && pnpm test` is both. */
function kindsOfCommand(command: string): AnswerClaimKind[] {
	return COMMAND_KINDS.filter((k) => k.re.test(command)).map((k) => k.kind)
}

/** The failed check the claim is about, or `undefined` when every failed check is plainly another kind. */
function failedCheckFor(
	record: TurnOutcome,
	claim: AnswerClaimKind,
): { command?: string } | undefined {
	const checks = Array.isArray(record.checks) ? record.checks : []
	const failed = checks.filter((c) => c?.result === 'failed')
	if (failed.length === 0) return {}
	const related = failed.filter((c) => {
		const kinds = kindsOfCommand(typeof c.command === 'string' ? c.command : '')
		return claim === 'checks' || kinds.length === 0 || kinds.some((kind) => sameKind(kind, claim))
	})
	if (related.length === 0) return undefined
	const only = related.length === 1 ? related[0]?.command : undefined
	return typeof only === 'string' ? { command: only } : {}
}

/**
 * The one mismatch between a plain claim in `answer` and this turn's `outcome`,
 * or `undefined`.
 *
 * Reports only when the record says a check failed, or says files changed and
 * no check ran or none established a pass. Never when the record says nothing
 * changed, that the checks passed, or that it cannot tell: in those the claim
 * may be true. English only: a claim in another language is not found.
 */
export function compareAnswerToOutcome(
	answer: string | undefined | null,
	outcome: TurnOutcome | undefined,
): AnswerClaimMismatch | undefined {
	// A notice is never worth failing a turn for: input that does not have the
	// expected shape (a hook-supplied record) is read as "nothing to say".
	try {
		return compare(answer, outcome)
	} catch {
		return undefined
	}
}

function compare(
	answer: string | undefined | null,
	outcome: TurnOutcome | undefined,
): AnswerClaimMismatch | undefined {
	if (typeof answer !== 'string' || answer === '' || !outcome) return undefined
	const verdict = outcome.verdict
	if (verdict !== 'failing' && verdict !== 'unchecked' && verdict !== 'inconclusive') {
		return undefined
	}
	for (const { sentenceEndsWithQuestion, clauses } of clausesOf(readableText(answer))) {
		if (sentenceEndsWithQuestion) continue
		for (const clause of clauses) {
			const pattern = claimIn(clause)
			if (!pattern) continue
			let record: AnswerClaimRecord
			let recordSays: string
			if (verdict === 'failing') {
				const failed = failedCheckFor(outcome, pattern.kind)
				if (!failed) continue
				record = 'check-failed'
				recordSays = failed.command
					? `${auditCommandText(failed.command)} failed`
					: 'a check failed'
			} else if (verdict === 'unchecked') {
				record = 'unchecked'
				recordSays = 'files changed and no check ran'
			} else {
				record = 'unreadable'
				recordSays = 'files changed and no check gave a result that could be read'
			}
			// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
			const folded = clause.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim()
			const quote =
				folded.length <= ANSWER_CLAIM_MAX_QUOTE_CHARS
					? folded
					: `${folded.slice(0, ANSWER_CLAIM_MAX_QUOTE_CHARS - 3)}...`
			return { claim: pattern.kind, said: pattern.said, quote, record, recordSays }
		}
	}
	return undefined
}

/** The mismatch as one plain line, for a person: `The answer says the tests pass. The record: ...` */
export function describeAnswerClaimMismatch(mismatch: AnswerClaimMismatch): string {
	return `The answer says ${mismatch.said}. The record: ${mismatch.recordSays}.`
}
