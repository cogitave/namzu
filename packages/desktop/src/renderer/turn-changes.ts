import type { ThreadState } from '../shared/projection.js'
import { type DiffReceipt, canonicalPaths, changeTotals, receiptOf } from './changes-totals.js'
import { type UndoCardView, undoCardView } from './undo-model.js'

export interface TurnChangeFile {
	/** The name a person recognises; the full path stays available for the tooltip. */
	name: string
	path: string
	added: number
	removed: number
	/** The diff carries only part of the file's lines; the counts are still the whole. */
	cut: boolean
	receiptIds: string[]
	/** The turn made this file: its first receipt had nothing before it. */
	created: boolean
}
export interface TurnChanges {
	turn: number
	files: TurnChangeFile[]
	added: number
	removed: number
	cut: boolean
	/** Every completed diff receipt of the turn, in the order the work happened. */
	receiptIds: string[]
	/** What the turn did to its files, for the card's title. */
	verb: 'Created' | 'Edited' | 'Changed'
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
	const byTurn = new Map<number, Map<string, { path: string; ids: string[]; created: boolean }>>()
	let anonymous = 0
	const canonical = canonicalPaths(
		thread.timeline.flatMap((entry) => {
			const tool = entry.kind === 'tool' ? thread.tools[entry.id] : undefined
			const receipt = tool?.status === 'completed' ? receiptOf(tool) : undefined
			return receipt?.path ? [receipt.path] : []
		}),
	)
	for (const entry of thread.timeline) {
		if (entry.kind !== 'tool') continue
		const tool = thread.tools[entry.id]
		const receipt = tool?.status === 'completed' ? receiptOf(tool) : undefined
		if (!tool || !receipt) continue
		const path = canonical(receipt.path ?? '') || receipt.label || ''
		const key = path || `receipt:${anonymous++}`
		const files = byTurn.get(entry.turn) ?? new Map()
		const file = files.get(key) ?? {
			path,
			ids: [],
			created: !receipt.before && Boolean(receipt.after),
		}
		file.ids.push(entry.id)
		files.set(key, file)
		byTurn.set(entry.turn, files)
	}
	const result = new Map<number, TurnChanges>()
	for (const [turn, grouped] of byTurn) {
		const files: TurnChangeFile[] = []
		for (const { path, ids, created } of grouped.values()) {
			const tools = ids.map((id) => thread.tools[id])
			const totals = changeTotals(
				tools.flatMap((tool): DiffReceipt[] => {
					const receipt = tool && receiptOf(tool)
					return receipt ? [receipt] : []
				}),
			)
			if (totals.files === 0) continue
			files.push({
				name: path ? baseName(path) : 'File',
				path: path || 'File',
				added: totals.added,
				removed: totals.removed,
				cut: totals.cut,
				receiptIds: ids,
				created,
			})
		}
		if (!files.length) continue
		const made = files.filter((file) => file.created).length
		result.set(turn, {
			turn,
			verb: made === files.length ? 'Created' : made === 0 ? 'Edited' : 'Changed',
			files,
			added: files.reduce((sum, file) => sum + file.added, 0),
			removed: files.reduce((sum, file) => sum + file.removed, 0),
			cut: files.some((file) => file.cut),
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
