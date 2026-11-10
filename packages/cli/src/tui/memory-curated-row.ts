/**
 * The quiet row left in the transcript when the small model changed stored
 * memory off the turn: `Remembered: …`, `Updated: …`, `Replaced: … → …`, one
 * line per change, all in one row. A claim it judged already held, not worth
 * keeping or unsafe leaves nothing.
 */

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The most lines one row shows; the rest are counted. */
export const CURATED_ROW_LINES = 5

export function memoryCuratedRow(lines: readonly string[]): string | undefined {
	const shown = lines.map(oneLine).filter((line) => line !== '')
	if (shown.length === 0) return undefined
	const visible = shown.slice(0, CURATED_ROW_LINES)
	const more = shown.length - visible.length
	return [...visible, ...(more > 0 ? [`and ${more} more`] : [])].join('\n')
}
