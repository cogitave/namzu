/**
 * The phrase language of composer triggers, compiled to a token automaton.
 *
 *   word          one token, matched after folding (`fold.ts`)
 *   (a|b c)       one of the alternatives; an alternative may be several words
 *   [a|b]         optional: one of the alternatives, or nothing
 *   <n>           a run of digits
 *   word+'        `word` itself, or `word` with an apostrophe suffix: `skill'e`
 *   {verb|verb}   any positive request form of the verbs, from `verbs.ts`
 *
 * No `RegExp` is ever built from a pattern: a pattern compiles to a small
 * nondeterministic automaton over tokens, and matching simulates it. The
 * simulation counts its steps so a test can bound the cost on a long draft
 * without reading a clock.
 */

import { fold } from './fold.js'
import { QUESTION_PARTICLES, verbForms } from './verbs.js'

type Atom =
	| { readonly kind: 'word'; readonly text: string }
	| { readonly kind: 'number' }
	| { readonly kind: 'suffix'; readonly base: string }

/** Flags a verb form carries into the match it ends. */
export const FORM_POLITE = 1
export const FORM_OPTATIVE = 2

interface Edge {
	readonly atom: Atom
	readonly to: number
	readonly flags: number
}

interface State {
	readonly edges: Edge[]
	readonly empty: number[]
}

export interface CompiledPattern {
	readonly source: string
	readonly states: readonly State[]
	readonly start: number
	readonly accept: number
	/** Words that can begin a match; `null` when a non-word atom can. */
	readonly firstWords: ReadonlySet<string> | null
}

export interface PatternMatch {
	/** Token indices, `end` exclusive. */
	readonly start: number
	readonly end: number
	/** `FORM_POLITE | FORM_OPTATIVE` from the verb form the match used. */
	readonly flags: number
}

/** Matching work done, for tests that bound cost by steps rather than time. */
export interface MatchStats {
	steps: number
}

type Node =
	| { readonly kind: 'atom'; readonly atom: Atom }
	| { readonly kind: 'sequence'; readonly items: readonly Node[] }
	| { readonly kind: 'choice'; readonly options: readonly Node[]; readonly optional: boolean }
	| { readonly kind: 'verb'; readonly verbs: readonly string[] }

export class PatternError extends Error {
	constructor(source: string, reason: string) {
		super(`Trigger phrase "${source}": ${reason}`)
		this.name = 'PatternError'
	}
}

export function compilePattern(source: string): CompiledPattern {
	const node = parse(source)
	const states: State[] = []
	const state = (): number => {
		states.push({ edges: [], empty: [] })
		return states.length - 1
	}
	const build = (current: Node, from: number): number => {
		switch (current.kind) {
			case 'atom': {
				const to = state()
				states[from]?.edges.push({ atom: current.atom, to, flags: 0 })
				return to
			}
			case 'sequence': {
				let at = from
				for (const item of current.items) at = build(item, at)
				return at
			}
			case 'choice': {
				const out = state()
				for (const option of current.options) {
					const end = build(option, from)
					states[end]?.empty.push(out)
				}
				if (current.optional) states[from]?.empty.push(out)
				return out
			}
			case 'verb': {
				const out = state()
				for (const verb of current.verbs) {
					for (const form of verbForms(verb)) {
						let at = from
						form.tokens.forEach((word, index) => {
							const to = index === form.tokens.length - 1 ? out : state()
							const flags =
								index === form.tokens.length - 1
									? (form.polite ? FORM_POLITE : 0) | (form.optative ? FORM_OPTATIVE : 0)
									: 0
							states[at]?.edges.push({ atom: { kind: 'word', text: word }, to, flags })
							at = to
						})
					}
				}
				return out
			}
		}
	}
	const start = state()
	const accept = build(node, start)
	const compiled = { source, states, start, accept, firstWords: null }
	return { ...compiled, firstWords: firstWords(compiled) }
}

function firstWords(pattern: Omit<CompiledPattern, 'firstWords'>): ReadonlySet<string> | null {
	const words = new Set<string>()
	for (const index of closure(pattern.states, [pattern.start])) {
		for (const edge of pattern.states[index]?.edges ?? []) {
			if (edge.atom.kind !== 'word') return null
			words.add(edge.atom.text)
		}
	}
	return words
}

function closure(states: readonly State[], seeds: readonly number[]): Set<number> {
	const seen = new Set<number>(seeds)
	const stack = [...seeds]
	while (stack.length > 0) {
		const index = stack.pop() as number
		for (const next of states[index]?.empty ?? []) {
			if (seen.has(next)) continue
			seen.add(next)
			stack.push(next)
		}
	}
	return seen
}

function atomMatches(atom: Atom, token: string): boolean {
	switch (atom.kind) {
		case 'word':
			return token === atom.text
		case 'number':
			return /^\d+$/u.test(token)
		case 'suffix':
			return token === atom.base || token.startsWith(`${atom.base}'`)
	}
}

/**
 * Every match of `pattern` that starts at token `start`, longest first. A
 * question particle (`mi`, `mu`) right after a match extends it by one token.
 */
export function matchAt(
	pattern: CompiledPattern,
	tokens: readonly string[],
	start: number,
	stats?: MatchStats,
): PatternMatch[] {
	const first = tokens[start]
	if (first === undefined) return []
	if (pattern.firstWords && !pattern.firstWords.has(first)) {
		if (stats) stats.steps += 1
		return []
	}
	const found: PatternMatch[] = []
	// A thread is a state and the flags of the forms it has read.
	let threads = new Map<string, { readonly state: number; readonly flags: number }>()
	for (const state of closure(pattern.states, [pattern.start]))
		threads.set(`${state}:0`, { state, flags: 0 })
	for (let at = start; at < tokens.length && threads.size > 0; at += 1) {
		const token = tokens[at] as string
		const next = new Map<string, { readonly state: number; readonly flags: number }>()
		for (const thread of threads.values()) {
			for (const edge of pattern.states[thread.state]?.edges ?? []) {
				if (stats) stats.steps += 1
				if (!atomMatches(edge.atom, token)) continue
				const flags = thread.flags | edge.flags
				for (const state of closure(pattern.states, [edge.to]))
					next.set(`${state}:${flags}`, { state, flags })
			}
		}
		threads = next
		for (const thread of threads.values()) {
			if (thread.state !== pattern.accept) continue
			const end = at + 1
			const particle = tokens[end]
			found.push({
				start,
				end: particle !== undefined && QUESTION_PARTICLES.has(particle) ? end + 1 : end,
				flags: thread.flags,
			})
		}
	}
	return found.sort((a, b) => b.end - a.end)
}

// ---------------------------------------------------------------------------
// parsing

function parse(source: string): Node {
	const text = source.trim()
	let index = 0
	const fail = (reason: string): never => {
		throw new PatternError(source, reason)
	}
	const skipSpace = () => {
		while (text[index] === ' ') index += 1
	}
	const sequence = (closers: string): Node => {
		const items: Node[] = []
		for (;;) {
			skipSpace()
			const char = text[index]
			if (char === undefined || closers.includes(char)) break
			if (char === '(' || char === '[') {
				index += 1
				const options = alternatives(char === '(' ? ')' : ']')
				items.push({ kind: 'choice', options, optional: char === '[' })
				continue
			}
			if (char === '{') {
				const close = text.indexOf('}', index)
				if (close < 0) fail('an unclosed {')
				const verbs = text
					.slice(index + 1, close)
					.split('|')
					.map((verb) => fold(verb.trim()))
				if (verbs.some((verb) => verb.length === 0)) fail('an empty verb in {}')
				items.push({ kind: 'verb', verbs })
				index = close + 1
				continue
			}
			if (text.startsWith('<n>', index)) {
				items.push({ kind: 'atom', atom: { kind: 'number' } })
				index += 3
				continue
			}
			let end = index
			while (end < text.length && !' ()[]{}|<'.includes(text[end] as string)) end += 1
			const raw = text.slice(index, end)
			if (raw.length === 0) fail(`an unexpected "${char}"`)
			index = end
			if (raw.endsWith("+'")) {
				items.push({ kind: 'atom', atom: { kind: 'suffix', base: fold(raw.slice(0, -2)) } })
				continue
			}
			const word = fold(raw)
			if (!/^[\p{L}\p{N}_]+(?:'[\p{L}\p{N}_]+)*$/u.test(word)) fail(`"${raw}" is not one word`)
			items.push({ kind: 'atom', atom: { kind: 'word', text: word } })
		}
		if (items.length === 0) fail('an empty alternative')
		return items.length === 1 ? (items[0] as Node) : { kind: 'sequence', items }
	}
	const alternatives = (closer: string): Node[] => {
		const options: Node[] = [sequence(`|${closer}`)]
		while (text[index] === '|') {
			index += 1
			options.push(sequence(`|${closer}`))
		}
		if (text[index] !== closer) fail(`a missing ${closer}`)
		index += 1
		return options
	}
	const node = sequence('')
	if (index < text.length) fail(`an unexpected "${text[index]}"`)
	return node
}
