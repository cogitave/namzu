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

/** A stretch of an outgoing message that was pasted: `[start, end)` in the expanded text. */
export interface PasteRange {
	readonly start: number
	readonly end: number
}

/**
 * `expandChips`, and where each put-back paste landed in the result. A chip
 * edited by hand stays as typed and is not a range.
 */
export function expandChipsWithRanges(
	value: string,
	pastes: ReadonlyMap<number, string>,
): { readonly text: string; readonly ranges: readonly PasteRange[] } {
	let text = ''
	let at = 0
	const ranges: PasteRange[] = []
	for (const match of value.matchAll(PASTE_CHIP)) {
		const pasted = pastes.get(Number(match[1]))
		if (pasted === undefined) continue
		text += value.slice(at, match.index)
		if (pasted.length > 0) ranges.push({ start: text.length, end: text.length + pasted.length })
		text += pasted
		at = match.index + match[0].length
	}
	return { text: text + value.slice(at), ranges }
}

/** `ranges` moved by `-shift` and cut to `[0, length)`; ranges left empty are dropped. */
export function shiftRanges(
	ranges: readonly PasteRange[],
	shift: number,
	length: number,
): readonly PasteRange[] {
	const out: PasteRange[] = []
	for (const range of ranges) {
		const start = Math.max(0, range.start - shift)
		const end = Math.min(length, range.end - shift)
		if (end > start) out.push({ start, end })
	}
	return out
}

/** `text` with every range blanked to spaces of the same length, so offsets keep their meaning. */
export function blankRanges(text: string, ranges: readonly PasteRange[] | undefined): string {
	if (!ranges || ranges.length === 0) return text
	let out = ''
	let at = 0
	for (const range of ranges) {
		out += text.slice(at, range.start) + ' '.repeat(Math.max(0, range.end - range.start))
		at = range.end
	}
	return out + text.slice(at)
}

/**
 * Run a mention expander over `text` with its pasted stretches blanked, so an
 * `@path` inside a paste is never read as a request for that file. The expander
 * only appends to the text, so what it adds is put after the real text.
 */
export function expandMentionsAround<T extends { readonly sendText: string }>(
	text: string,
	pasted: readonly PasteRange[] | undefined,
	expand: (text: string) => T,
): T {
	if (!pasted || pasted.length === 0) return expand(text)
	const blanked = blankRanges(text, pasted)
	const expanded = expand(blanked)
	if (!expanded.sendText.startsWith(blanked)) return expanded
	return { ...expanded, sendText: text + expanded.sendText.slice(blanked.length) }
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
 * pair with the attachments in order (the highest ones, when the text names
 * more than were attached); when it names fewer (a message from before markers
 * were kept), the attachments take the numbers after `floor` instead.
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
	// More markers than attachments: a recalled message or a look-alike left
	// extra ones in the text, and a new attachment always numbers above every
	// number the conversation had used, so the attachments are the highest.
	const matched = (['Image', 'Document'] as const).every(
		(kind) => queue[kind].length >= kinds.filter((k) => k === kind).length,
	)
	if (matched) {
		for (const kind of ['Image', 'Document'] as const) {
			const count = kinds.filter((k) => k === kind).length
			queue[kind] = queue[kind].slice(queue[kind].length - count)
		}
		return kinds.map((kind) => queue[kind].shift() as number)
	}
	const start = Math.max(floor, ...markers.map((m) => m.id))
	return kinds.map((_, index) => start + index + 1)
}

/** The highest image or document number `text` names, or 0. */
export function highestAttachmentNumber(text: string): number {
	let highest = 0
	for (const marker of attachmentMarkers(text)) highest = Math.max(highest, marker.id)
	return highest
}

const NUMBERS_GIVEN = new WeakMap<object, number>()

/** The composer says which number it gave an attachment, so a sent row never re-derives it from text. */
export function noteAttachmentNumber(attachment: object, id: number): void {
	NUMBERS_GIVEN.set(attachment, id)
}

/** The number the composer gave `attachment`, when it is the same object. */
export function givenAttachmentNumber(attachment: object): number | undefined {
	return NUMBERS_GIVEN.get(attachment)
}

/**
 * `text` with each pasted stretch folded back into its chip, numbered in the
 * order they stand: what the transcript shows for a sent message, so a long
 * paste is one short row, as it was in the box. The model still gets the text.
 */
export function chipPastedRanges(text: string, ranges: readonly PasteRange[] | undefined): string {
	if (!ranges || ranges.length === 0) return text
	let out = ''
	let at = 0
	let id = 0
	for (const range of ranges) {
		if (range.start < at || range.end > text.length) return text
		id += 1
		out += text.slice(at, range.start) + pasteChip(id, text.slice(range.start, range.end))
		at = range.end
	}
	return out + text.slice(at)
}
