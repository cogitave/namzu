/**
 * Paste chips live inside the composer text: `[Pasted text #1 +40 lines]`,
 * `[Pasted text #2]` (no extra lines), `[Image #3]`. The text they stand for
 * is held beside the draft and put back when the message is sent.
 */

const PASTE_CHIP = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g
const ANY_CHIP = /\[(?:Pasted text #\d+(?: \+\d+ lines)?|Image #\d+|Document #\d+)\]$/

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

/** The chip that ends exactly at `cursor`, so Backspace can remove it whole. */
export function chipBefore(
	value: string,
	cursor: number,
): { readonly start: number; readonly chip: string } | null {
	const match = ANY_CHIP.exec(value.slice(0, cursor))
	return match ? { start: match.index, chip: match[0] } : null
}

/** The message carries images as attachments, so their chips are not part of its words. */
export function stripAttachmentChips(value: string): string {
	return value.replace(/ ?\[(?:Image|Document) #\d+\]/g, '')
}
