/**
 * The key hints a screen shows, in one vocabulary, and how they are cut.
 *
 * A picker or prompt draws its hint line inside its own box and the footer
 * under the composer stays quiet while a box is open, so a screen never says
 * the same keys twice. The words are the same on every screen: `↑↓ select`,
 * `enter apply`, `esc back` where the key returns to the previous screen and
 * `esc cancel` where it drops what was being done.
 *
 * When the line is wider than its room it loses whole hints, least important
 * first. A hint is never cut in the middle of a word, so a person never reads
 * half of a key name.
 */

export interface Hint {
	readonly text: string
	/** Higher stays longer when the line is too wide. The default is 1. */
	readonly rank?: number
	/**
	 * A shorter way to say the same key, used before the hint is given up. It is
	 * a whole hint of its own, never a cut of `text`.
	 */
	readonly short?: string
}

/**
 * Columns a hint line may use inside a bordered, padded box that the app draws
 * with one column of padding on each side of the terminal: the host's inset,
 * the box's border and its padding, two columns each. `columns - 4` was the
 * border and the padding alone, two columns too many, and the last hint
 * wrapped.
 */
export function boxedHintWidth(columns: number | undefined): number {
	return Math.max(1, (columns ?? 80) - 6)
}

const SEPARATOR = ' · '

/**
 * The hints that fit in `width` columns, joined with ` · `, in the order given.
 * The lowest-ranked hint is shortened (when it has a short form) and then goes
 * (the later of two equals), until the line fits or one remains. A single hint wider than `width` is returned whole and
 * left to wrap; half of it would be worse than all of it.
 */
export function fitHints(hints: readonly (string | Hint)[], width: number): string {
	const kept: { text: string; rank: number; short: string | undefined }[] = hints
		.map((hint) =>
			typeof hint === 'string'
				? { text: hint, rank: 1, short: undefined }
				: { text: hint.text, rank: hint.rank ?? 1, short: hint.short },
		)
		.filter((hint) => hint.text.length > 0)
	const length = () =>
		kept.reduce((sum, hint) => sum + hint.text.length, 0) +
		SEPARATOR.length * Math.max(0, kept.length - 1)
	while (kept.length > 1 && length() > width) {
		let drop = 0
		for (let i = 1; i < kept.length; i++) {
			if ((kept[i]?.rank ?? 1) <= (kept[drop]?.rank ?? 1)) drop = i
		}
		const victim = kept[drop]
		const shortens = (hint: (typeof kept)[number] | undefined) =>
			hint?.short !== undefined && hint.short.length < hint.text.length
		// Its short form first, then the short form of an equal (the later one
		// first), and only then is the hint given up: when the hints that must
		// stay are all of one rank, each one says less before any one is lost.
		const peers = kept.filter((hint) => hint.rank === victim?.rank && shortens(hint))
		const shorter = shortens(victim) ? victim : peers.at(-1)
		if (shorter?.short !== undefined) {
			shorter.text = shorter.short
			shorter.short = undefined
		} else {
			kept.splice(drop, 1)
		}
	}
	// One hint left and still too wide: its short form, if it has one, before it
	// is returned whole to wrap.
	const only = kept[0]
	if (kept.length === 1 && only !== undefined && only.text.length > width && only.short) {
		return only.short.length < only.text.length ? only.short : only.text
	}
	return kept.map((hint) => hint.text).join(SEPARATOR)
}

/**
 * A hint line already written as one string, fitted to `width`: `enter` becomes
 * `↵` first, then middle hints go, then the first, and the last (the key that
 * leaves) stays. Text with no separator is cut at a word and ends in `…`.
 */
export function fitHintText(text: string, width: number): string {
	if (width <= 0) return ''
	if (text.length <= width) return text
	const returned = text.replace(/\benter\b/g, '↵')
	if (returned.length <= width) return returned
	const parts = returned.split(SEPARATOR)
	if (parts.length > 1) {
		while (parts.length > 1 && parts.join(SEPARATOR).length > width) {
			parts.splice(parts.length > 2 ? 1 : 0, 1)
		}
		return parts.join(SEPARATOR)
	}
	if (width === 1) return '…'
	const room = returned.slice(0, width - 1)
	const space = room.lastIndexOf(' ')
	return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}…`
}
