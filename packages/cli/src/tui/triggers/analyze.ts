/**
 * A draft read the way the trigger matcher needs it: word tokens with their
 * place in the draft, the clauses they fall in, and the stretches of text
 * that are not the operator speaking in their own words.
 *
 * - Tokens come from one regular expression over the folded text
 *   (`fold.ts`): runs of letters, digits and `_`, joined across an inner
 *   apostrophe, so `skill'e` and `don't` are one token each and `e-posta`
 *   is two. No `Intl.Segmenter` word mode, whose answers depend on the ICU
 *   build.
 * - A clause ends at `.`, `;`, `!`, `?`, `…`, a comma, a colon, a bracket, a
 *   newline, an en or em dash, or a hyphen with space on both sides. A hyphen
 *   inside a word (`e-posta`, `sub-agents`) is not an edge.
 * - An exclusion zone is code (`` `…` `` and fenced blocks), a quotation
 *   (`"…"`, `“…”`, `«…»`, `‘…’`, and `'…'` where the `'` stands at a word
 *   edge, so `skill'e` is not a quote), a URL, an `@mention`, anything
 *   path-like, and a line that starts with `>`. An opener with no closer
 *   excludes everything after it. Tokens inside a zone stay in the stream as
 *   words — they still decide where a clause begins and ends — but no match
 *   may touch one.
 *
 * Pure. Offsets are UTF-16 code units of the draft.
 */

import { foldWithMap } from './fold.js'

export interface Token {
	/** Folded text. */
	readonly text: string
	/** Offsets in the draft. */
	readonly start: number
	readonly end: number
	/** The clause this token belongs to. */
	readonly clause: number
	/** A clause edge (or the start of the draft) lies between the previous token and this one. */
	readonly edgeBefore: boolean
	/** A clause edge (or the end of the draft) lies between this token and the next. */
	readonly edgeAfter: boolean
	/** The text between this token and the next contains a `:`. */
	readonly colonAfter: boolean
	/** Inside an exclusion zone. */
	readonly excluded: boolean
}

export interface Clause {
	readonly first: number
	readonly last: number
	/** The clause is ended by a `?`. */
	readonly question: boolean
}

export interface Analysis {
	readonly tokens: readonly Token[]
	readonly clauses: readonly Clause[]
	/** Draft ranges no match may overlap. */
	readonly zones: readonly (readonly [number, number])[]
}

const WORD = /[\p{L}\p{N}_]+(?:'[\p{L}\p{N}_]+)*/gu
/** Characters that end a clause wherever they stand. */
const EDGE_CHARACTERS = /[.;!?…,:()[\]{}\n–—]/u
/**
 * A hyphen (or two) with space on both sides: `fix it - then ship`. The gap
 * between two tokens is only the text between them, so a bare `-` there is
 * a hyphen inside a word (`e-posta`), not an edge.
 */
const SPACED_HYPHEN = /\s-{1,2}\s/u

export function analyze(draft: string): Analysis {
	const folded = foldWithMap(draft)
	const zones = mergeZones(exclusionZones(draft))
	let zone = 0
	const raw: Array<{ text: string; fStart: number; fEnd: number; start: number; end: number }> = []
	for (const match of folded.text.matchAll(WORD)) {
		const fStart = match.index
		const fEnd = fStart + match[0].length
		raw.push({
			text: match[0],
			fStart,
			fEnd,
			start: folded.map[fStart] ?? 0,
			end: folded.map[fEnd] ?? draft.length,
		})
	}
	const tokens: Token[] = []
	const clauses: Clause[] = []
	let clause = 0
	let clauseFirst = 0
	for (let index = 0; index < raw.length; index += 1) {
		const token = raw[index]
		if (!token) continue
		const previous = raw[index - 1]
		const next = raw[index + 1]
		const gapBefore = previous ? folded.text.slice(previous.fEnd, token.fStart) : ''
		const gapAfter = folded.text.slice(token.fEnd, next ? next.fStart : folded.text.length)
		const edgeBefore = !previous || isEdge(gapBefore)
		const edgeAfter = !next || isEdge(gapAfter)
		if (edgeBefore && index > 0) {
			clauses.push({ first: clauseFirst, last: index - 1, question: gapBefore.includes('?') })
			clause += 1
			clauseFirst = index
		}
		// Tokens and merged zones both run left to right: one pass.
		while (zone < zones.length && (zones[zone]?.[1] ?? 0) <= token.start) zone += 1
		const current = zones[zone]
		tokens.push({
			text: token.text,
			start: token.start,
			end: token.end,
			clause,
			edgeBefore,
			edgeAfter,
			colonAfter: gapAfter.includes(':'),
			excluded: current !== undefined && token.start < current[1] && token.end > current[0],
		})
	}
	if (raw.length > 0) {
		const last = raw[raw.length - 1]
		const tail = last ? folded.text.slice(last.fEnd) : ''
		clauses.push({ first: clauseFirst, last: raw.length - 1, question: tail.includes('?') })
	}
	return { tokens, clauses, zones }
}

function isEdge(gap: string): boolean {
	return EDGE_CHARACTERS.test(gap) || SPACED_HYPHEN.test(gap)
}

/** Whether `[start, end)` of the draft touches an exclusion zone. */
export function inZone(analysis: Analysis, start: number, end: number): boolean {
	// Zones are merged and sorted: find the first one ending after `start`.
	const zones = analysis.zones
	let low = 0
	let high = zones.length
	while (low < high) {
		const middle = (low + high) >> 1
		if ((zones[middle]?.[1] ?? 0) <= start) low = middle + 1
		else high = middle
	}
	const zone = zones[low]
	return zone !== undefined && zone[0] < end
}

/** Sorted, non-overlapping. */
function mergeZones(
	zones: ReadonlyArray<readonly [number, number]>,
): Array<readonly [number, number]> {
	const sorted = [...zones].sort((a, b) => a[0] - b[0])
	const merged: [number, number][] = []
	for (const [from, to] of sorted) {
		const last = merged[merged.length - 1]
		if (last && from <= last[1]) last[1] = Math.max(last[1], to)
		else merged.push([from, to])
	}
	return merged
}

// ---------------------------------------------------------------------------
// exclusion zones

const PAIRS: ReadonlyArray<readonly [string, string]> = [
	['“', '”'],
	['«', '»'],
	['‘', '’'],
]
const URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/giu
const MENTION = /(?<![\p{L}\p{N}_])@[\w./~-]+/gu
/** A run of non-space characters with a slash or backslash in it, or a `name.ext`. */
const PATH_LIKE =
	/[^\s"'`“”«»‘’()]*[/\\][^\s"'`“”«»‘’()]*|(?<![\p{L}\p{N}_])[\p{L}\p{N}_-]+\.[a-z][a-z0-9]{0,5}(?![\p{L}\p{N}_])/giu

export function exclusionZones(draft: string): Array<readonly [number, number]> {
	const zones: Array<readonly [number, number]> = []
	// Code first: a quote inside code is code, and a backtick inside a quote
	// is still the operator's quotation.
	scanDelimited(draft, zones)
	for (const pattern of [URL, MENTION, PATH_LIKE]) {
		for (const match of draft.matchAll(pattern)) {
			if (match[0].length === 0) continue
			zones.push([match.index, match.index + match[0].length])
		}
	}
	// A line quoted with `>` is somebody else's text.
	let lineStart = 0
	for (const line of draft.split('\n')) {
		if (/^\s*>/u.test(line)) zones.push([lineStart, lineStart + line.length])
		lineStart += line.length + 1
	}
	return zones
}

/**
 * Code spans, fenced blocks and quotations, left to right. Each opener runs
 * to its closer; an opener with no closer runs to the end of the draft.
 */
function scanDelimited(draft: string, zones: Array<readonly [number, number]>): void {
	let index = 0
	while (index < draft.length) {
		const char = draft[index] ?? ''
		if (draft.startsWith('```', index)) {
			const close = draft.indexOf('```', index + 3)
			const end = close < 0 ? draft.length : close + 3
			zones.push([index, end])
			index = end
			continue
		}
		if (char === '`') {
			const close = draft.indexOf('`', index + 1)
			const end = close < 0 ? draft.length : close + 1
			zones.push([index, end])
			index = end
			continue
		}
		if (char === '"') {
			const close = draft.indexOf('"', index + 1)
			const end = close < 0 ? draft.length : close + 1
			zones.push([index, end])
			index = end
			continue
		}
		const pair = PAIRS.find(([open]) => open === char)
		if (pair) {
			const close = draft.indexOf(pair[1], index + 1)
			const end = close < 0 ? draft.length : close + 1
			zones.push([index, end])
			index = end
			continue
		}
		if (char === "'" && opensQuote(draft, index)) {
			let close = -1
			for (let at = index + 1; at < draft.length; at += 1) {
				if (draft[at] === "'" && closesQuote(draft, at)) {
					close = at
					break
				}
			}
			const end = close < 0 ? draft.length : close + 1
			zones.push([index, end])
			index = end
			continue
		}
		index += 1
	}
}

const LETTER = /[\p{L}\p{N}_]/u

/** An ASCII `'` opens a quotation only at the start of a word: nothing word-like before it, something after. */
function opensQuote(draft: string, index: number): boolean {
	const before = draft[index - 1]
	const after = draft[index + 1]
	return (before === undefined || !LETTER.test(before)) && after !== undefined && !/\s/u.test(after)
}

/** …and closes one only at the end of a word: something before it, nothing word-like after. */
function closesQuote(draft: string, index: number): boolean {
	const before = draft[index - 1]
	const after = draft[index + 1]
	return before !== undefined && !/\s/u.test(before) && (after === undefined || !LETTER.test(after))
}
