import type { ActionDelivery, ActionRetrySafety } from '@namzu/sdk'
import type { ParsedUiTree } from './ui-tree.js'

/**
 * Verifying an input by what it changed.
 *
 * The driver cannot say whether a background input arrived, so the adapter
 * reads the target window before and after and compares the two. What the
 * window shows is the only evidence: the text it holds, as controls name it
 * or give it as their value.
 *
 * An input is verified only by a change that belongs to it:
 * - typed text is verified when that text is now shown where it was not;
 * - any other input (a press, a key) is verified when the window changed and
 *   then held still, and nothing was changing it before: a window that
 *   changes by itself (a clock, a spinner) proves nothing;
 * - a new window of the same program is verified by its title.
 * Otherwise the input stays unconfirmed. A change of unrelated text is never
 * reported as the effect.
 */

/** Every text a window shows, with how many times it shows it. */
export type Observation = ReadonlyMap<string, number>

const MAX_TEXT = 240
const SEP = '\u0000'
/** Keys that carry a control's state (selected, disabled), not text: they never count as text shown. */
const STATE = '\u0001'
/** Present in a read that could not show everything: a text cut short, or a walk cut at its cap. */
export const CUT = '\u0002cut'

/** Whether a read left something out, so that an unchanged read proves nothing. */
export const isCut = (obs: Observation): boolean => obs.has(CUT)

/** The texts of one read of a window: each control's name and each value. */
export function observationOf(
	tree: ParsedUiTree,
	options: { readonly walkCut?: boolean } = {},
): Observation {
	const out = new Map<string, number>()
	if (options.walkCut === true) out.set(CUT, 1)
	const add = (key: string): void => {
		out.set(key, (out.get(key) ?? 0) + 1)
	}
	for (const node of tree.nodes) {
		const name = node.name.trim()
		const value = node.element.value?.trim()
		if (name.length > MAX_TEXT || (value?.length ?? 0) > MAX_TEXT) out.set(CUT, 1)
		if (name !== '') add(`${node.role}${SEP}${name.slice(0, MAX_TEXT)}`)
		if (value !== undefined && value !== '') add(`${node.role}${SEP}=${value.slice(0, MAX_TEXT)}`)
		for (const state of node.element.states ?? [])
			add(`${STATE}${node.role}${SEP}${name.slice(0, MAX_TEXT)}${SEP}${state}`)
	}
	return out
}

export interface ObservedChange {
	/** Texts shown now that were not (or fewer times) before. */
	readonly added: readonly string[]
	/** Texts shown before that are gone. */
	readonly removed: readonly string[]
}

const isMeta = (key: string): boolean => key.startsWith(STATE) || key === CUT

const textOf = (key: string): string => {
	const at = key.indexOf(SEP)
	const text = at < 0 ? key : key.slice(at + 1)
	return text.startsWith('=') ? text.slice(1) : text
}

export function changeBetween(before: Observation, after: Observation): ObservedChange {
	const added: string[] = []
	const removed: string[] = []
	for (const [key, count] of after)
		if (!isMeta(key) && count > (before.get(key) ?? 0)) added.push(textOf(key))
	for (const [key, count] of before)
		if (!isMeta(key) && count > (after.get(key) ?? 0)) removed.push(textOf(key))
	return { added, removed }
}

/** Whether every control's state (selected, disabled) is the same in two reads. */
export const sameState = (a: Observation, b: Observation): boolean => {
	for (const [key, count] of a) if (key.startsWith(STATE) && b.get(key) !== count) return false
	for (const [key, count] of b) if (key.startsWith(STATE) && a.get(key) !== count) return false
	return true
}

export const sameObservation = (a: Observation, b: Observation): boolean => {
	const { added, removed } = changeBetween(a, b)
	return added.length === 0 && removed.length === 0 && sameState(a, b)
}

/** Text as a person types it against how a window may show it: case, spaces and operator glyphs differ. */
export function foldText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, '').replace(/\*/g, '×').replace(/\//g, '÷')
}

const quote = (value: string, max = 80): string =>
	JSON.stringify(value.length > max ? `${value.slice(0, max - 1)}…` : value)

/** How many times a folded text occurs in everything a window shows. */
function occurrences(obs: Observation, want: string): number {
	let total = 0
	for (const [key, count] of obs) {
		if (isMeta(key)) continue
		const text = foldText(textOf(key))
		let at = text.indexOf(want)
		while (at >= 0) {
			total += count
			at = text.indexOf(want, at + want.length)
		}
	}
	return total
}

const countOf = (text: string, want: string): number => {
	if (want === '') return 0
	let n = 0
	for (let at = text.indexOf(want); at >= 0; at = text.indexOf(want, at + want.length)) n++
	return n
}

export interface ObservedVerdict {
	readonly delivery: ActionDelivery
	readonly retrySafety: ActionRetrySafety
	/** What the window reads now: the evidence, shown to the model as `reads "…"`. */
	readonly observed?: string
	readonly detail: string
	/**
	 * Set when no effect was seen: `no_effect` means the window provably did not
	 * change (a retry is safe); `unexplained` means it changed in a way that cannot
	 * be tied to the input (a retry is not safe).
	 */
	readonly outcome?: 'no_effect' | 'unexplained'
}

/**
 * Whether the window shows the effect of an input the driver could not
 * confirm. `later` is a read taken a moment after `after`: equal reads mean
 * the window had settled. Undefined means nothing observable followed.
 */
export function judgeObserved(
	input: { readonly typed?: string },
	reads: {
		readonly before: Observation
		readonly after: Observation
		/** A read just before `before`: unequal reads mean the window was changing by itself. */
		readonly earlier?: Observation
		readonly later?: Observation
	},
): ObservedVerdict | undefined {
	const change = changeBetween(reads.before, reads.after)
	if (input.typed !== undefined) {
		const want = foldText(input.typed)
		if (want !== '') {
			// Typed text counts only when the window shows it more often than before; a
			// short text (a letter, a digit) is no evidence inside other text, so it
			// must appear as a text of its own.
			const short = want.length < 3
			const shown =
				occurrences(reads.after, want) > occurrences(reads.before, want)
					? change.added.find((text) =>
							short ? foldText(text) === want : foldText(text).includes(want),
						)
					: undefined
			if (shown !== undefined)
				return {
					delivery: 'delivered_verified',
					retrySafety: 'unsafe',
					observed: shown,
					detail: 'The window shows the text typed.',
				}
		}
		return undefined
	}
	const stateOnly = change.added.length === 0 && change.removed.length === 0
	if (stateOnly && sameState(reads.before, reads.after)) return undefined
	// A window still changing a moment later, or one that changed before the input, says nothing.
	if (reads.later !== undefined && !sameObservation(reads.after, reads.later)) return undefined
	if (reads.earlier !== undefined && !sameObservation(reads.earlier, reads.before)) return undefined
	if (stateOnly)
		return {
			delivery: 'delivered_verified',
			retrySafety: 'unsafe',
			detail:
				'A control of the window changed state (selected or enabled) after the input and then held still.',
		}
	const now = change.added[0]
	const was = change.removed[0]
	const said =
		was !== undefined
			? now !== undefined
				? `It read ${quote(was)} before the input.`
				: `The window no longer shows ${quote(was)}.`
			: 'The window showed nothing like it before the input.'
	return {
		delivery: 'delivered_verified',
		retrySafety: 'unsafe',
		...(now !== undefined ? { observed: now } : {}),
		detail: `The window changed after the input and then held still. ${said}`,
	}
}

/** What a message to a classic edit control did, as the control reads afterwards. */
export interface EditReading {
	readonly found: boolean
	readonly reason: string
	readonly done: boolean
	readonly seen: string
}

export interface EditVerdict {
	readonly ok: boolean
	readonly delivery: ActionDelivery
	readonly retrySafety: ActionRetrySafety
	readonly detail?: string
	readonly readBack?: { readonly expected?: string; readonly observed?: string }
}

const UIPI_TEXT =
	'this window belongs to a program running with higher rights, so text cannot be sent to it. Ask the user; do not try to get around it.'

/**
 * `set` or `type` on a classic edit control, judged by the text the control
 * reads back: the control is the evidence, not the message that returned.
 */
export function judgeEdit(op: 'set' | 'type', text: string, reading: EditReading): EditVerdict {
	const expected = trimOf(text)
	if (reading.reason === 'uipi')
		return { ok: false, delivery: 'not_delivered', retrySafety: 'safe', detail: UIPI_TEXT }
	if (reading.reason === 'read_only')
		return {
			ok: false,
			delivery: 'not_delivered',
			retrySafety: 'safe',
			detail: 'this text control is read-only, so nothing was sent.',
		}
	if (reading.reason === 'hung')
		return {
			ok: true,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
			detail:
				'the program did not answer the text in time. It may have arrived; look at the window before sending it again.',
		}
	if (reading.reason !== '')
		return {
			ok: true,
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
			detail:
				'the text was sent, but the control could not be read back. Look at the window before sending it again.',
		}
	if (reading.done)
		return {
			ok: true,
			delivery: 'delivered_verified',
			retrySafety: op === 'set' ? 'safe' : 'unsafe',
			readBack: { expected, observed: trimOf(reading.seen) },
		}
	return {
		ok: true,
		delivery: 'delivered_unverified',
		retrySafety: 'unsafe',
		readBack: { expected, observed: trimOf(reading.seen) },
		detail:
			op === 'set'
				? `the control changed, but it reads ${quote(reading.seen)} instead of the text sent; it may have reformatted it. Check before setting it again.`
				: `the control does not read as having received the text (around the caret it reads ${quote(reading.seen)}). Look at the window before typing it again.`,
	}
}

const trimOf = (value: string, max = 80): string =>
	value.length > max ? `${value.slice(0, max - 1)}…` : value

/** A before and after read of an edit control, for a keyboard delivery the driver could not confirm. */
export function judgeEditBetween(
	typed: string,
	before: { readonly text: string; readonly len: number },
	after: { readonly text: string; readonly len: number },
): ObservedVerdict | undefined {
	const norm = (value: string): string => value.replace(/\r\n?/g, '\n')
	const a = norm(after.text)
	const want = norm(typed)
	if (after.len === before.len && a === norm(before.text)) return undefined
	// The text must occur more often than before: a change elsewhere in a control
	// that already held it proves nothing, and a longer text alone is not evidence.
	if (want === '') return undefined
	// A read keeps only the start of a very long text: when both reads were cut, the
	// length is all that is left to compare, and it must have grown by exactly the typed text.
	const cut = after.len > after.text.length && before.len > before.text.length
	if (cut && after.len - before.len === want.length)
		return {
			delivery: 'delivered_verified',
			retrySafety: 'unsafe',
			detail: 'The text control grew by the length of the text typed.',
		}
	const at = a.indexOf(want)
	if (at < 0) return undefined
	if (countOf(a, want) <= countOf(norm(before.text), want)) return undefined
	const from = Math.max(0, at - 40)
	const seen = a.slice(from, from + want.length + 80)
	return {
		delivery: 'delivered_verified',
		retrySafety: 'unsafe',
		observed: seen,
		detail: 'The text control now holds the text typed.',
	}
}
