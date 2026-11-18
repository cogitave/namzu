/**
 * Which stretches of the message box were pasted.
 *
 * The box is plain text, so a paste is indistinguishable from typing once it
 * lands. This keeps the stretches a person pasted, moved along as they edit,
 * so the engine can tell their own words from the material they brought. What
 * the box shows never changes.
 */

export interface PasteRange {
	readonly start: number
	readonly end: number
	/** The pasted text itself, so a stretch that no longer matches the box is never trusted. */
	readonly text: string
}

/** A paste longer than this many characters is material. */
export const MATERIAL_PASTE_CHARS = 800
/** A paste with more newlines than this is material. */
export const MATERIAL_PASTE_NEWLINES = 2

export function isMaterialPaste(text: string): boolean {
	if (text.length > MATERIAL_PASTE_CHARS) return true
	let newlines = 0
	for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) newlines += 1
	return newlines > MATERIAL_PASTE_NEWLINES
}

/**
 * `ranges` after the box went from `previous` to `next`: stretches before the
 * change stay, stretches after it move by the change's length, and a stretch
 * the change touches is dropped, since part of it is no longer what was pasted.
 */
export function trackEdit(
	ranges: readonly PasteRange[],
	previous: string,
	next: string,
): readonly PasteRange[] {
	if (ranges.length === 0 || previous === next) return ranges
	const shortest = Math.min(previous.length, next.length)
	let prefix = 0
	while (prefix < shortest && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1
	let suffix = 0
	while (
		suffix < shortest - prefix &&
		previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
	)
		suffix += 1
	const delta = next.length - previous.length
	const out: PasteRange[] = []
	for (const range of ranges) {
		if (range.end <= prefix) out.push(range)
		else if (range.start >= previous.length - suffix)
			out.push({ ...range, start: range.start + delta, end: range.end + delta })
	}
	return out
}

/**
 * `ranges` with the paste that was just put at `start` added, when `next`
 * really holds it there. The box cuts a paste at its limit, so a shorter
 * stretch than was pasted is kept as far as it goes.
 */
export function addPaste(
	ranges: readonly PasteRange[],
	next: string,
	start: number,
	pasted: string,
): readonly PasteRange[] {
	const held = next.slice(start, start + pasted.length)
	if (held.length === 0 || !pasted.startsWith(held)) return ranges
	return [...ranges, { start, end: start + held.length, text: held }].sort(
		(a, b) => a.start - b.start,
	)
}

/** The ranges that still hold exactly what was pasted, as the engine takes them. */
export function confirmedRanges(
	ranges: readonly PasteRange[] | undefined,
	draft: string,
): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = []
	let floor = 0
	for (const range of ranges ?? []) {
		if (range.start < floor || draft.slice(range.start, range.end) !== range.text) continue
		out.push({ start: range.start, end: range.end })
		floor = range.end
	}
	return out
}
