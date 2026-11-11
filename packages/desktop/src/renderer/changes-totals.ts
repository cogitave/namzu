import { parseDiffFromFile } from '@pierre/diffs'

export interface DiffReceipt {
	path?: string
	label?: string
	before?: string
	after?: string
	/**
	 * What the engine counted for this one edit. Absent for a receipt that came without counts
	 * (a pending change, or a conversation saved before edits carried them); its own `before` and
	 * `after` are compared instead.
	 */
	added?: number
	removed?: number
	/** The engine carried only part of this edit's lines; the counts still cover all of it. */
	cut?: boolean
}

export interface ChangeTotals {
	added: number
	removed: number
	files: number
	/** Some edit's lines were cut to a bounded size; the numbers are still the true ones. */
	cut: boolean
}

/** Most lines of one edit the engine carries; beyond this the diff shows a part, the count the whole. */
export const CARRIED_DIFF_LINES = 400

/** Said beside a number whose diff was cut, so a short diff beside a long count is not a mismatch. */
export const CUT_NOTE = `First ${CARRIED_DIFF_LINES} lines shown`

// A file this large costs more to compare than the figure is worth in a popover.
const MAX_COMPARED_CHARACTERS = 4_000_000

const comparedCounts = new WeakMap<object, { added: number; removed: number }>()

function compared(receipt: DiffReceipt, name: string): { added: number; removed: number } {
	const hit = comparedCounts.get(receipt)
	if (hit) return hit
	const before = receipt.before ?? ''
	const after = receipt.after ?? ''
	let counts = { added: 0, removed: 0 }
	if (before !== after && before.length + after.length <= MAX_COMPARED_CHARACTERS) {
		try {
			const diff = parseDiffFromFile({ name, contents: before }, { name, contents: after })
			for (const hunk of diff.hunks) {
				counts.added += hunk.additionLines
				counts.removed += hunk.deletionLines
			}
		} catch {
			// An unreadable pair is left out rather than guessed at.
			counts = { added: 0, removed: 0 }
		}
	}
	comparedCounts.set(receipt, counts)
	return counts
}

/** The lines one edit added and removed: the engine's own count, else its own two sides compared. */
export function receiptCounts(receipt: DiffReceipt): { added: number; removed: number } {
	if (receipt.added !== undefined || receipt.removed !== undefined)
		return { added: receipt.added ?? 0, removed: receipt.removed ?? 0 }
	return compared(receipt, receipt.path || receipt.label || 'file')
}

/**
 * The one place a change number comes from. A file's numbers are the sum of its edits' own
 * counts, so a file edited twice reads what `git diff` reads, never the first edit's removed
 * lines set against the last edit's added ones. Receipts without a path stand alone.
 */
export function changeTotals(receipts: Iterable<DiffReceipt>): ChangeTotals {
	const byFile = new Map<string, { added: number; removed: number; cut: boolean }>()
	let anonymous = 0
	for (const receipt of receipts) {
		const key = receipt.path || receipt.label || `receipt:${anonymous++}`
		const counts = receiptCounts(receipt)
		const file = byFile.get(key)
		if (file) {
			file.added += counts.added
			file.removed += counts.removed
			if (receipt.cut) file.cut = true
		} else byFile.set(key, { ...counts, cut: receipt.cut === true })
	}
	const totals: ChangeTotals = { added: 0, removed: 0, files: 0, cut: false }
	for (const file of byFile.values()) {
		if (file.added + file.removed === 0) continue
		totals.added += file.added
		totals.removed += file.removed
		totals.files++
		if (file.cut) totals.cut = true
	}
	return totals
}

/** A finished edit as a receipt: the diff it drew, and the counts the engine reported for it. */
export function receiptOf(tool: {
	view: { kind: string; path?: string; label?: string; before?: string; after?: string }
	facts?: { kind: string; added?: number; removed?: number; hunksTruncated?: true }
}): DiffReceipt | undefined {
	const { view, facts } = tool
	if (view.kind !== 'diff') return undefined
	const reported = facts?.kind === 'edit' || facts?.kind === 'write' ? facts : undefined
	const counted = reported && (reported.added !== undefined || reported.removed !== undefined)
	return {
		path: view.path,
		label: view.label,
		before: view.before,
		after: view.after,
		...(counted ? { added: reported.added ?? 0, removed: reported.removed ?? 0 } : {}),
		...(reported?.hunksTruncated ? { cut: true } : {}),
	}
}

const grouped = new Intl.NumberFormat('en-US')
export const formatLineCount = (value: number) => grouped.format(value)
