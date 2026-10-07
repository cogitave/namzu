import type { ThreadState } from '../shared/projection.js'
import { changeTotals } from './changes-totals.js'
import { type UndoCardView, undoCardView } from './undo-model.js'

export interface TurnChangeFile {
	/** The name a person recognises; the full path stays available for the tooltip. */
	name: string
	path: string
	added: number
	removed: number
	receiptIds: string[]
}
export interface TurnChanges {
	turn: number
	files: TurnChangeFile[]
	added: number
	removed: number
	/** Every completed diff receipt of the turn, in the order the work happened. */
	receiptIds: string[]
}

// Streaming rebuilds `tools` on every update, but finished receipts keep their view objects, so
// a file's totals are reused while its receipts are the same objects.
const totalsCache = new WeakMap<
	object,
	{ views: object[]; totals: ReturnType<typeof changeTotals> }
>()
function cachedTotals(views: object[]): ReturnType<typeof changeTotals> {
	const first = views[0]
	if (!first) return changeTotals([])
	const hit = totalsCache.get(first)
	if (hit && hit.views.length === views.length && hit.views.every((v, i) => v === views[i]))
		return hit.totals
	const totals = changeTotals(views)
	totalsCache.set(first, { views, totals })
	return totals
}

export function baseName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '')
	return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || trimmed
}

/**
 * Completed edits grouped by the turn whose timeline entry carries the receipt, so restored
 * history and live work group the same way. A file whose edits cancel out is left out; a turn
 * with nothing left has no entry.
 */
export function turnChanges(
	thread: Pick<ThreadState, 'timeline' | 'tools'>,
): Map<number, TurnChanges> {
	const byTurn = new Map<number, Map<string, { path: string; ids: string[] }>>()
	let anonymous = 0
	for (const entry of thread.timeline) {
		if (entry.kind !== 'tool') continue
		const tool = thread.tools[entry.id]
		if (!tool || tool.status !== 'completed' || tool.view.kind !== 'diff') continue
		const path = tool.view.path || tool.view.label || ''
		const key = path || `receipt:${anonymous++}`
		const files = byTurn.get(entry.turn) ?? new Map()
		const file = files.get(key) ?? { path, ids: [] }
		file.ids.push(entry.id)
		files.set(key, file)
		byTurn.set(entry.turn, files)
	}
	const result = new Map<number, TurnChanges>()
	for (const [turn, grouped] of byTurn) {
		const files: TurnChangeFile[] = []
		for (const { path, ids } of grouped.values()) {
			const totals = cachedTotals(
				ids.map((id) => {
					const view = thread.tools[id]?.view
					return view?.kind === 'diff' ? view : {}
				}),
			)
			if (totals.files === 0) continue
			files.push({
				name: path ? baseName(path) : 'File',
				path: path || 'File',
				added: totals.added,
				removed: totals.removed,
				receiptIds: ids,
			})
		}
		if (!files.length) continue
		result.set(turn, {
			turn,
			files,
			added: files.reduce((sum, file) => sum + file.added, 0),
			removed: files.reduce((sum, file) => sum + file.removed, 0),
			receiptIds: files.flatMap((file) => file.receiptIds),
		})
	}
	return result
}

/**
 * Joins a card to the journal turn that made its edits and reads that turn's undo state.
 * A turn without an id (still streaming, or restored without work) offers no undo.
 */
export function turnUndo(
	thread: Pick<ThreadState, 'turns' | 'undo' | 'running'>,
	turn: number,
	onUndoTurn: ((turnId: string) => void) | undefined,
	kept?: Record<string, number>,
): { undo?: UndoCardView; onUndo?: () => void } {
	const turnId = thread.turns[turn]?.turnId
	if (!onUndoTurn || !turnId) return {}
	const undo = undoCardView(thread.undo?.[turnId], { busy: thread.running, kept: kept?.[turnId] })
	return undo ? { undo, onUndo: () => onUndoTurn(turnId) } : {}
}
