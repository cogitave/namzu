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

/**
 * Most lines of one edit the engine carries; beyond this the diff shows a part, the count the
 * whole. The kernel's own cap lives in `packages/sdk/src/tools/builtins/line-diff.ts`; a test
 * keeps the two equal, because the screen cannot import the kernel at run time.
 */
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

const isAbsolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)

/**
 * One name per file. The kernel names a file by its resolved path in its counts and the model by
 * the path it typed in the diff, so the same file can arrive as `/work/shop/src/cart.js` and as
 * `src/cart.js`; the typed, shorter path is the name both go by.
 */
export function canonicalPaths(paths: Iterable<string>): (path: string) => string {
	const all = [...new Set(paths)].filter(Boolean)
	const relative = all.filter((path) => !isAbsolute(path))
	const memo = new Map<string, string>()
	return (path) => {
		if (!path || !isAbsolute(path)) return path
		const hit = memo.get(path)
		if (hit !== undefined) return hit
		let best = path
		for (const candidate of relative) {
			const tail = candidate.replace(/^\.\//, '')
			if (
				(path.endsWith(`/${tail}`) || path.endsWith(`\\${tail}`)) &&
				(best === path || tail.length > best.length)
			)
				best = tail
		}
		memo.set(path, best)
		return best
	}
}

/**
 * Edits that undo each other: every edit carries both sides, each starts where the one before
 * ended, and the last ends where the first began. `git diff` shows nothing for such a file, so no
 * number is shown for it either. Edits whose sides are separate fragments are never judged this
 * way, since equal ends there prove nothing.
 */
function cancelsOut(list: readonly DiffReceipt[]): boolean {
	if (list.length < 2) return false
	for (const [index, receipt] of list.entries()) {
		if (receipt.before === undefined || receipt.after === undefined || receipt.cut) return false
		const next = list[index + 1]
		if (next && next.before !== receipt.after) return false
	}
	return list[0]?.before === list[list.length - 1]?.after
}

/**
 * The one place a change number comes from. A file's numbers are the sum of its edits' own
 * counts, so a file edited twice reads what `git diff` reads, never the first edit's removed
 * lines set against the last edit's added ones. Receipts without a path stand alone.
 */
export function changeTotals(receipts: Iterable<DiffReceipt>): ChangeTotals {
	const byFile = new Map<
		string,
		{ added: number; removed: number; cut: boolean; list: DiffReceipt[] }
	>()
	let anonymous = 0
	const list = [...receipts]
	const canonical = canonicalPaths(list.map((receipt) => receipt.path ?? ''))
	for (const receipt of list) {
		const key = canonical(receipt.path ?? '') || receipt.label || `receipt:${anonymous++}`
		const counts = receiptCounts(receipt)
		const file = byFile.get(key)
		if (file) {
			file.added += counts.added
			file.removed += counts.removed
			file.list.push(receipt)
			if (receipt.cut) file.cut = true
		} else byFile.set(key, { ...counts, cut: receipt.cut === true, list: [receipt] })
	}
	const totals: ChangeTotals = { added: 0, removed: 0, files: 0, cut: false }
	for (const file of byFile.values()) {
		if (file.added + file.removed === 0 || cancelsOut(file.list)) continue
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
	facts?: {
		kind: string
		path?: string
		added?: number
		removed?: number
		hunksTruncated?: true
	}
}): DiffReceipt | undefined {
	const { view, facts } = tool
	const reported = facts?.kind === 'edit' || facts?.kind === 'write' ? facts : undefined
	const counted = reported && (reported.added !== undefined || reported.removed !== undefined)
	if (view.kind !== 'diff') {
		// A batch edit or an insert carries no diff, only the engine's counts for the file.
		if (!reported || !counted || !reported.path) return undefined
		return {
			path: reported.path,
			added: reported.added ?? 0,
			removed: reported.removed ?? 0,
			...(reported.hunksTruncated ? { cut: true } : {}),
		}
	}
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
