/**
 * Paste chips live inside the composer text: `[Pasted text #1 +40 lines]`,
 * `[Pasted text #2]` (no extra lines), `[Image #3]`. The text they stand for
 * is held beside the draft and put back when the message is sent.
 */

const PASTE_CHIP = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g
const ANY_CHIP = /\[(?:Pasted text #(\d+)(?: \+\d+ lines)?|(?:Image|Document) #\d+)\]/g
const ATTACHMENT_MARKER = /\[(Image|Document) #(\d+)\]/g

/** A paste longer than this many characters becomes a chip. */
export const PASTE_CHIP_CHARS = 800

/** More newlines than this becomes a chip: min(rows - 10, 2). */
export function pasteChipLines(rows: number): number {
	return Math.min(rows - 10, 2)
}

export function isChipPaste(text: string, rows: number): boolean {
	let newlines = 0
	for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) newlines += 1
	return text.length > PASTE_CHIP_CHARS || newlines > pasteChipLines(rows)
}

export function pasteChip(id: number, text: string): string {
	let newlines = 0
	for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) newlines += 1
	return newlines > 0 ? `[Pasted text #${id} +${newlines} lines]` : `[Pasted text #${id}]`
}

export function attachmentChip(kind: 'Image' | 'Document', id: number): string {
	return `[${kind} #${id}]`
}

/** Put every pasted text back where its chip stands. A chip that was edited by hand stays as typed. */
export function expandChips(value: string, pastes: ReadonlyMap<number, string>): string {
	return value.replace(PASTE_CHIP, (chip, id: string) => pastes.get(Number(id)) ?? chip)
}

/**
 * What stands behind markers in a draft: the exact text of each attached
 * image or document marker, and the number of each held paste. Text that looks
 * like a marker but is in neither is ordinary text.
 */
export interface KnownChips {
	readonly attachments: ReadonlySet<string>
	readonly pastes: ReadonlySet<number>
}

export interface ChipRange {
	readonly start: number
	readonly end: number
	readonly text: string
}

/** Every marker in `value` with something behind it, in order. */
export function chipRanges(value: string, known: KnownChips): readonly ChipRange[] {
	const found: ChipRange[] = []
	for (const match of value.matchAll(ANY_CHIP)) {
		const text = match[0]
		const paste = match[1]
		const real = paste !== undefined ? known.pastes.has(Number(paste)) : known.attachments.has(text)
		if (real) found.push({ start: match.index, end: match.index + text.length, text })
	}
	return found
}

/**
 * `position`, moved out of any marker it falls inside. `bias` says which way:
 * -1 to the marker's start, 1 to its end, 0 to the nearer.
 */
export function snapOutOfChip(
	ranges: readonly ChipRange[],
	position: number,
	bias: -1 | 0 | 1,
): number {
	for (const chip of ranges) {
		if (position <= chip.start || position >= chip.end) continue
		if (bias < 0) return chip.start
		if (bias > 0) return chip.end
		return position - chip.start <= chip.end - position ? chip.start : chip.end
	}
	return position
}

/** `[start, end)` grown to take every marker it cuts through whole. */
export function widenOverChips(
	ranges: readonly ChipRange[],
	start: number,
	end: number,
): readonly [number, number] {
	let from = start
	let to = end
	for (const chip of ranges) {
		if (from > chip.start && from < chip.end) from = chip.start
		if (to > chip.start && to < chip.end) to = chip.end
	}
	return [from, to]
}

/**
 * One edit of `previous` that keeps every marker whole. `edit` replaces
 * `[start, deleteEnd)` of `previous` with `inserted`. A cut that reaches into a
 * marker takes all of it, and text typed inside one goes after it, so no edit
 * leaves half a marker behind. Returns the draft and where the cursor goes,
 * given where the edit would have put it.
 */
export function keepChipsWhole(
	previous: string,
	ranges: readonly ChipRange[],
	edit: { readonly start: number; readonly deleteEnd: number },
	inserted: string,
	cursorAfter: number,
): { readonly value: string; readonly cursor: number } {
	let { start, deleteEnd } = edit
	if (start === deleteEnd) {
		start = snapOutOfChip(ranges, start, 1)
		deleteEnd = start
	} else [start, deleteEnd] = widenOverChips(ranges, start, deleteEnd)
	const value = previous.slice(0, start) + inserted + previous.slice(deleteEnd)
	const typicalCursor = edit.start + inserted.length
	const cursor = cursorAfter === typicalCursor ? start + inserted.length : cursorAfter
	return { value, cursor }
}

/** The numbers of the image and document markers in `text`, in order, with their kind. */
export function attachmentMarkers(
	text: string,
): readonly { readonly kind: 'Image' | 'Document'; readonly id: number }[] {
	return [...text.matchAll(ATTACHMENT_MARKER)].map((match) => ({
		kind: match[1] as 'Image' | 'Document',
		id: Number(match[2]),
	}))
}

/**
 * The number each attachment of a message goes by. The message text names them
 * in the order they were attached, so the markers of its kind, lowest first,
 * pair with the attachments in order; when the text does not name exactly as
 * many as there are attachments (a message from before markers were kept, or a
 * look-alike typed by hand), the attachments take the numbers after `floor`
 * instead.
 */
export function numberAttachments(
	text: string,
	kinds: readonly ('Image' | 'Document')[],
	floor: number,
): readonly number[] {
	const markers = attachmentMarkers(text)
	const queue = {
		Image: [...new Set(markers.filter((m) => m.kind === 'Image').map((m) => m.id))].sort(
			(a, b) => a - b,
		),
		Document: [...new Set(markers.filter((m) => m.kind === 'Document').map((m) => m.id))].sort(
			(a, b) => a - b,
		),
	}
	const matched = (['Image', 'Document'] as const).every(
		(kind) => queue[kind].length === kinds.filter((k) => k === kind).length,
	)
	if (matched) return kinds.map((kind) => queue[kind].shift() as number)
	const start = Math.max(floor, ...markers.map((m) => m.id))
	return kinds.map((_, index) => start + index + 1)
}

/** The highest image or document number `text` names, or 0. */
export function highestAttachmentNumber(text: string): number {
	let highest = 0
	for (const marker of attachmentMarkers(text)) highest = Math.max(highest, marker.id)
	return highest
}
