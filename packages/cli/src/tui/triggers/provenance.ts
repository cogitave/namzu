/**
 * Where the characters of a composer draft came from, kept as the spans that
 * were NOT typed one key at a time here, and moved along with every edit.
 *
 * Only a human keystroke in this composer arms a trigger. A paste, a burst
 * of input that arrives as one chunk (a paste without bracketed-paste
 * markers looks exactly like that), a recalled or restored prompt, text from
 * the external editor, a yank and an accepted completion are all text the
 * operator did not type here, so a trigger in them is only suggested; Alt+W
 * arms it.
 *
 * Pure: the Composer owns the state and calls these on each edit.
 */

export type EditOrigin =
	| 'typed'
	| 'burst'
	| 'pasted'
	| 'recalled'
	| 'restored'
	| 'editor'
	| 'yank'
	| 'completion'

/** `[start, end)` in UTF-16 code units of the draft. */
export type Span = readonly [number, number]

export interface Edit {
	/** Where the replaced stretch starts in the previous draft. */
	readonly start: number
	/** Where it ends in the previous draft. */
	readonly deleteEnd: number
	/** How many code units replaced it. */
	readonly insertLength: number
}

/**
 * The single replacement that turns `previous` into `next`. The shared
 * prefix is capped at `cursor` — the cursor before the edit, where every
 * composer edit starts or ends — so an edit inside a run of identical
 * characters is placed where it actually happened.
 */
export function diffEdit(previous: string, next: string, cursor: number): Edit {
	let prefix = 0
	const limit = Math.min(previous.length, next.length, Math.max(0, cursor))
	while (prefix < limit && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1
	let suffix = 0
	const room = Math.min(previous.length, next.length) - prefix
	while (
		suffix < room &&
		previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
	)
		suffix += 1
	return {
		start: prefix,
		deleteEnd: previous.length - suffix,
		insertLength: next.length - suffix - prefix,
	}
}

/**
 * Move the non-typed spans through one edit, adding the inserted text unless
 * it was typed. A span the edit cuts through keeps the parts on either side;
 * the replaced part goes, and what replaced it is typed or not by `origin`.
 */
export function applyEdit(spans: readonly Span[], edit: Edit, origin: EditOrigin): Span[] {
	const delta = edit.insertLength - (edit.deleteEnd - edit.start)
	const moved: Span[] = []
	for (const [from, to] of spans) {
		if (to <= edit.start) moved.push([from, to])
		else if (from >= edit.deleteEnd) moved.push([from + delta, to + delta])
		else {
			if (from < edit.start) moved.push([from, edit.start])
			if (to > edit.deleteEnd) moved.push([edit.deleteEnd + delta, to + delta])
		}
	}
	if (origin !== 'typed' && edit.insertLength > 0)
		moved.push([edit.start, edit.start + edit.insertLength])
	return normalize(moved)
}

/** The spans of a draft replaced whole (history, restore, editor, reset). */
export function replaceAll(length: number, origin: EditOrigin): Span[] {
	return origin === 'typed' || length === 0 ? [] : [[0, length]]
}

/** Sorted and merged. */
export function normalize(spans: readonly Span[]): Span[] {
	const sorted = [...spans].sort((a, b) => a[0] - b[0])
	const merged: [number, number][] = []
	for (const [from, to] of sorted) {
		const last = merged[merged.length - 1]
		if (last && from <= last[1]) last[1] = Math.max(last[1], to)
		else merged.push([from, to])
	}
	return merged
}

/** An Alt+W decision about the trigger whose words span `[start, end)`. */
export interface TriggerOverride {
	readonly id: string
	readonly start: number
	readonly end: number
	readonly state: 'dropped' | 'armed'
}

/**
 * Move Alt+W decisions through an edit. An edit inside a decided trigger's
 * words forgets the decision: new keystrokes there are the operator saying
 * it again, and the trigger is read afresh. Typing before or after the words
 * keeps it.
 */
export function shiftOverrides(
	overrides: readonly TriggerOverride[],
	edit: Edit,
): TriggerOverride[] {
	const delta = edit.insertLength - (edit.deleteEnd - edit.start)
	const kept: TriggerOverride[] = []
	for (const override of overrides) {
		if (edit.deleteEnd <= override.start)
			kept.push({ ...override, start: override.start + delta, end: override.end + delta })
		else if (edit.start >= override.end) kept.push(override)
	}
	return kept
}

/** The overrides as `detectTriggers` reads them: by hit key `id@start`. */
export function overrideMap(
	overrides: readonly TriggerOverride[],
): Map<string, 'dropped' | 'armed'> {
	return new Map(overrides.map((override) => [`${override.id}@${override.start}`, override.state]))
}
