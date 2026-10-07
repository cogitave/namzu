import { parseDiffFromFile } from '@pierre/diffs'

export interface DiffReceipt {
	path?: string
	label?: string
	before?: string
	after?: string
}

export interface ChangeTotals {
	added: number
	removed: number
	files: number
}

// A file this large costs more to compare than the figure is worth in a popover.
const MAX_COMPARED_CHARACTERS = 4_000_000

/**
 * Line totals for the completed edits of one conversation. A path counts once, from the first
 * `before` to the last `after`, so a file edited five times is not counted five times; an edit
 * that restores the original contributes nothing. Receipts without a path stand alone.
 */
export function changeTotals(receipts: Iterable<DiffReceipt>): ChangeTotals {
	const spans = new Map<string, { before: string; after: string }>()
	let anonymous = 0
	for (const receipt of receipts) {
		const key = receipt.path || receipt.label || `receipt:${anonymous++}`
		const span = spans.get(key)
		if (span) span.after = receipt.after ?? ''
		else spans.set(key, { before: receipt.before ?? '', after: receipt.after ?? '' })
	}
	let added = 0
	let removed = 0
	let files = 0
	for (const [name, span] of spans) {
		if (span.before === span.after) continue
		if (span.before.length + span.after.length > MAX_COMPARED_CHARACTERS) continue
		try {
			const diff = parseDiffFromFile(
				{ name, contents: span.before },
				{ name, contents: span.after },
			)
			let fileAdded = 0
			let fileRemoved = 0
			for (const hunk of diff.hunks) {
				fileAdded += hunk.additionLines
				fileRemoved += hunk.deletionLines
			}
			if (fileAdded + fileRemoved === 0) continue
			added += fileAdded
			removed += fileRemoved
			files++
		} catch {
			// An unreadable pair is left out rather than guessed at.
		}
	}
	return { added, removed, files }
}

const grouped = new Intl.NumberFormat('en-US')
export const formatLineCount = (value: number) => grouped.format(value)
