import { randomBytes } from 'node:crypto'

/**
 * The leak tripwire for learning. Guidance is built from retained evidence; if
 * that evidence, or the guidance built from it, carries what the independent
 * evaluation holds back, the evaluation measures nothing. This module decides
 * that a text or a path set carries such material, and says so without ever
 * echoing the material.
 *
 * Four kinds of evaluator-side material are recognised:
 *
 * - `path`: a location that belongs to the evaluator (answers, rubrics,
 *   verdicts, protection fixtures), given as globs.
 * - `canary`: a random string the host planted inside evaluator data. It has no
 *   other reason to appear anywhere, so one sighting is proof of a leak.
 * - `marker`: wording that only a grader's output or an answer key carries.
 * - `protected-content`: the verbatim text of a protection task or an answer.
 *
 * and one kind of material that must not travel at all: `secret`.
 *
 * A finding names the kind, the subject that carried it and the rule that
 * matched. It never contains the matched text.
 */

/** @experimental What counts as evaluator-side material for one experiment. */
export interface LearningLeakGuard {
	/** Globs for evaluator-owned locations. `*` stays in a segment, `**` crosses them. */
	readonly paths?: readonly string[]
	/** Canary strings planted in evaluator data; see {@link createLearningCanary}. */
	readonly canaries?: readonly string[]
	/** Extra wording that only evaluator output carries, as plain text or a RegExp. */
	readonly markers?: readonly (string | RegExp)[]
	/** Verbatim evaluator-side texts (protection task prompts, expected answers). */
	readonly protectedContents?: readonly string[]
	/** Literal secret values the host knows about, beyond the built-in key shapes. */
	readonly secrets?: readonly string[]
}

/** @experimental The kinds of material the tripwire recognises. */
export type LearningLeakKind = 'path' | 'canary' | 'marker' | 'protected-content' | 'secret'

/** @experimental Where a leak was seen and what rule saw it; never the matched text. */
export interface LearningLeakFinding {
	readonly kind: LearningLeakKind
	/** The subject that carried it, such as `failure.trace` or `candidate.body`. */
	readonly subject: string
	/** The rule that matched: `default:<name>`, or `<kind>[<index>]` into the host's guard. */
	readonly rule: string
}

/** One thing to inspect: free text, a set of paths, or both. */
export interface LearningLeakSubject {
	readonly subject: string
	readonly text?: string
	readonly paths?: readonly string[]
}

/** @experimental Thrown for a leak. It is a leak, not a false positive: do not retry past it. */
export class LearningLeakError extends Error {
	readonly findings: readonly LearningLeakFinding[]
	constructor(findings: readonly LearningLeakFinding[]) {
		super(describeLeak(findings))
		this.name = 'LearningLeakError'
		this.findings = findings
	}
}

const MIN_PROTECTED_LENGTH = 12
const MAX_SCAN_CHARS = 1_000_000

const DEFAULT_MARKERS: readonly (readonly [string, RegExp])[] = [
	['grader-verdict', /\b(?:grader|judge|evaluator|scorer)[\s_-]*verdicts?\b/i],
	['answer-key', /\b(?:answer[\s_-]*key|expected[\s_-]*answers?|reference[\s_-]*answers?)\b/i],
	[
		'protection-fixture',
		/\bprotection[\s_-]*(?:task|fixture)[\s_-]*(?:contents?|prompts?|answers?)\b/i,
	],
	['hidden-rubric', /\b(?:hidden|private|held[\s_-]*out)[\s_-]*(?:rubric|test[\s_-]*cases?)\b/i],
]

const DEFAULT_SECRETS: readonly (readonly [string, RegExp])[] = [
	['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	['api-key', /\bsk-[A-Za-z0-9_-]{20,}/],
	['cloud-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
	['token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,})/],
	['bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/],
]

/** @experimental A fresh canary to plant in evaluator data. It matches nothing else. */
export function createLearningCanary(): string {
	return `namzu-canary-${randomBytes(12).toString('hex')}`
}

/** Fold case, zero-width characters and whitespace runs so spacing tricks do not hide a match. */
function fold(text: string): string {
	return text.replace(/[​-‏⁠﻿]/g, '').replace(/\s+/g, ' ').toLowerCase()
}

function globToRegExp(glob: string): RegExp {
	let out = ''
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i] as string
		if (c === '*') {
			if (glob[i + 1] === '*') {
				i++
				if (glob[i + 1] === '/') {
					i++
					out += '(?:.*/)?'
				} else out += '.*'
			} else out += '[^/]*'
		} else if (c === '?') out += '[^/]'
		else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
	}
	return new RegExp(`^${out}$`)
}

function normalizePath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/^(?:\.\/)+/, '')
		.replace(/\/{2,}/g, '/')
}

/** Tokens of a text that look like locations, so a path glob can be tried on them. */
function pathTokens(text: string): string[] {
	return text
		.split(/[\s"'`<>()[\]{},;|=]+/)
		.map((token) => normalizePath(token.replace(/[:.]+$/, '')))
		.filter((token) => token.length > 0 && token.length < 512)
}

/** Plain-text forms, matched against the folded (lowercased) text. Hex is case-insensitive that way. */
function plainForms(canary: string): string[] {
	return [fold(canary), Buffer.from(canary, 'utf8').toString('hex')]
}

/**
 * Base64 forms of the canary at each of the three alignments it can have inside
 * a larger encoded blob, in standard and url-safe alphabets. The characters
 * that depend on the bytes before or after the canary are dropped, so what is
 * left is identical wherever the canary sits. Matched case-sensitively.
 */
function base64Forms(canary: string): string[] {
	const forms = new Set<string>()
	const body = Buffer.from(canary, 'utf8')
	for (let lead = 0; lead < 3; lead++) {
		const encoded = Buffer.concat([Buffer.alloc(lead, 0x78), body]).toString('base64')
		const unpadded = encoded.replace(/=+$/, '')
		const trailing = (lead + body.length) % 3 === 0 ? 0 : 1
		const stable = unpadded.slice(lead === 0 ? 0 : lead + 1, unpadded.length - trailing)
		if (stable.length < 8) continue
		forms.add(stable)
		forms.add(stable.replace(/\+/g, '-').replace(/\//g, '_'))
	}
	return [...forms]
}

/** Text with whitespace and zero-width characters removed, so wrapped base64 still matches. */
function compact(text: string): string {
	return text.replace(/[\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, '')
}

function stripZeroWidth(text: string): string {
	return text.replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
}

interface CompiledGuard {
	readonly paths: readonly (readonly [string, RegExp])[]
	readonly canaries: readonly (readonly [string, readonly string[], readonly string[]])[]
	readonly markers: readonly (readonly [string, RegExp])[]
	readonly protectedContents: readonly (readonly [string, string])[]
	readonly secrets: readonly (readonly [string, string])[]
}

function compile(guard: LearningLeakGuard): CompiledGuard {
	const markers: (readonly [string, RegExp])[] = [
		...DEFAULT_MARKERS.map(([n, r]) => [`default:${n}`, r] as const),
	]
	for (const [i, marker] of (guard.markers ?? []).entries()) {
		if (typeof marker !== 'string' && marker.global)
			throw new Error('A leak marker must not be a global RegExp.')
		const escaped =
			typeof marker === 'string'
				? new RegExp(fold(marker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
				: marker
		markers.push([`marker[${i}]`, escaped])
	}
	return {
		paths: (guard.paths ?? []).map(
			(g, i) => [`path[${i}]`, globToRegExp(normalizePath(g))] as const,
		),
		canaries: (guard.canaries ?? []).map((c, i) => {
			if (fold(c).length < 8) throw new Error('A leak canary must be at least 8 characters.')
			return [`canary[${i}]`, plainForms(c), base64Forms(c)] as const
		}),
		markers,
		protectedContents: (guard.protectedContents ?? []).flatMap((c, i) => {
			const folded = fold(c).trim()
			if (folded.length < MIN_PROTECTED_LENGTH)
				throw new Error(
					`Protected content must be at least ${MIN_PROTECTED_LENGTH} characters; shorter text matches innocently.`,
				)
			return [[`protected-content[${i}]`, folded] as const]
		}),
		secrets: (guard.secrets ?? []).flatMap((s, i) => {
			if (s.length < 8) throw new Error('A literal secret to guard must be at least 8 characters.')
			return [[`secret[${i}]`, s] as const]
		}),
	}
}

/**
 * @experimental Inspect each subject against the guard (the built-in markers
 * and secret shapes always apply). Returns every finding; empty means nothing
 * was seen, which is not a proof that nothing leaked.
 */
export function scanForLearningLeak(
	guard: LearningLeakGuard | undefined,
	subjects: readonly LearningLeakSubject[],
): LearningLeakFinding[] {
	const compiled = compile(guard ?? {})
	const findings: LearningLeakFinding[] = []
	const seen = new Set<string>()
	const add = (kind: LearningLeakKind, subject: string, rule: string) => {
		const key = `${kind}|${subject}|${rule}`
		if (seen.has(key)) return
		seen.add(key)
		findings.push({ kind, subject, rule })
	}
	for (const item of subjects) {
		for (const path of item.paths ?? []) {
			const normalized = normalizePath(path)
			for (const [rule, re] of compiled.paths)
				if (re.test(normalized)) add('path', item.subject, rule)
		}
		if (item.text === undefined) continue
		const text = item.text.length > MAX_SCAN_CHARS ? item.text.slice(0, MAX_SCAN_CHARS) : item.text
		const folded = fold(text)
		const lower = text.toLowerCase()
		const packed = compiled.canaries.length ? compact(text) : ''
		for (const [rule, forms, encoded] of compiled.canaries)
			if (
				forms.some((f) => folded.includes(f) || lower.includes(f)) ||
				encoded.some((f) => packed.includes(f))
			)
				add('canary', item.subject, rule)
		for (const [rule, content] of compiled.protectedContents)
			if (folded.includes(content)) add('protected-content', item.subject, rule)
		for (const [rule, re] of compiled.markers)
			if (re.test(folded) || re.test(text)) add('marker', item.subject, rule)
		for (const [rule, secret] of compiled.secrets)
			if (text.includes(secret)) add('secret', item.subject, rule)
		const unzeroed = stripZeroWidth(text)
		for (const [name, re] of DEFAULT_SECRETS)
			if (re.test(text) || re.test(unzeroed)) add('secret', item.subject, `default:${name}`)
		if (compiled.paths.length) {
			for (const token of pathTokens(text))
				for (const [rule, re] of compiled.paths) if (re.test(token)) add('path', item.subject, rule)
		}
	}
	return findings
}

/** @experimental Throws {@link LearningLeakError} when any subject carries evaluator-side material. */
export function assertNoLearningLeak(
	guard: LearningLeakGuard | undefined,
	subjects: readonly LearningLeakSubject[],
): void {
	const findings = scanForLearningLeak(guard, subjects)
	if (findings.length) throw new LearningLeakError(findings)
}

function describeLeak(findings: readonly LearningLeakFinding[]): string {
	const where = findings
		.slice(0, 6)
		.map((f) => `${f.subject} (${f.kind}, ${f.rule})`)
		.join('; ')
	const more = findings.length > 6 ? `; and ${findings.length - 6} more` : ''
	return `Leak refused: evaluator-side material reached the learning input or output at ${where}${more}. This is a leak, not a false positive. Nothing was built from it, and the matched text is not repeated here. Remove it from the evidence source or the evaluator data location and rerun.`
}
