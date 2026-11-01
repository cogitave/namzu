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

/** The texts of one read of a window: each control's name and each value. */
export function observationOf(tree: ParsedUiTree): Observation {
	const out = new Map<string, number>()
	const add = (key: string): void => {
		out.set(key, (out.get(key) ?? 0) + 1)
	}
	for (const node of tree.nodes) {
		const name = node.name.trim()
		if (name !== '') add(`${node.role}${SEP}${name.slice(0, MAX_TEXT)}`)
		const value = node.element.value?.trim()
		if (value !== undefined && value !== '') add(`${node.role}${SEP}=${value.slice(0, MAX_TEXT)}`)
	}
	return out
}

export interface ObservedChange {
	/** Texts shown now that were not (or fewer times) before. */
	readonly added: readonly string[]
	/** Texts shown before that are gone. */
	readonly removed: readonly string[]
}

const textOf = (key: string): string => {
	const at = key.indexOf(SEP)
	const text = at < 0 ? key : key.slice(at + 1)
	return text.startsWith('=') ? text.slice(1) : text
}

export function changeBetween(before: Observation, after: Observation): ObservedChange {
	const added: string[] = []
	const removed: string[] = []
	for (const [key, count] of after) if (count > (before.get(key) ?? 0)) added.push(textOf(key))
	for (const [key, count] of before) if (count > (after.get(key) ?? 0)) removed.push(textOf(key))
	return { added, removed }
}

export const sameObservation = (a: Observation, b: Observation): boolean => {
	const { added, removed } = changeBetween(a, b)
	return added.length === 0 && removed.length === 0
}

/** Text as a person types it against how a window may show it: case, spaces and operator glyphs differ. */
export function foldText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, '').replace(/\*/g, '×').replace(/\//g, '÷')
}

const quote = (value: string, max = 80): string =>
	JSON.stringify(value.length > max ? `${value.slice(0, max - 1)}…` : value)

export interface ObservedVerdict {
	readonly delivery: ActionDelivery
	readonly retrySafety: ActionRetrySafety
	/** What the window reads now: the evidence, shown to the model as `reads "…"`. */
	readonly observed?: string
	readonly detail: string
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
			const shown = change.added.find((text) => foldText(text).includes(want))
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
	if (change.added.length === 0 && change.removed.length === 0) return undefined
	// A window still changing a moment later, or one that changed before the input, says nothing.
	if (reads.later !== undefined && !sameObservation(reads.after, reads.later)) return undefined
	if (reads.earlier !== undefined && !sameObservation(reads.earlier, reads.before)) return undefined
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
