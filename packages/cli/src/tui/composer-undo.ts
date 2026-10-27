/**
 * Undo for the composer's draft.
 *
 * Each edit saves the draft as it was before, so Ctrl+_ steps back one edit.
 * Letters typed one after another count as one edit, ended by a space or by
 * any other kind of change, so undoing a typed sentence goes word by word and
 * never key by key. The stack holds the last 50 edits.
 *
 * Pure: the composer owns the state and calls `record` before each edit.
 */
import type { Span } from './triggers/provenance.js'

export const UNDO_LIMIT = 50

export interface DraftSnapshot {
	readonly value: string
	readonly cursor: number
	readonly spans: readonly Span[]
}

export interface UndoStack {
	/**
	 * Save `before` ahead of an edit that produces `after`. `typed` says the
	 * edit is one typed character; a run of those saves one snapshot.
	 */
	record(before: DraftSnapshot, after: string, typed: string | null): void
	/** The draft before the latest edit, which is then forgotten; undefined when there is none. */
	undo(): DraftSnapshot | undefined
	/** Forget everything, as after a send. */
	clear(): void
	readonly size: number
}

export function createUndoStack(limit: number = UNDO_LIMIT): UndoStack {
	const items: DraftSnapshot[] = []
	/** The draft a still-open run of typed letters ended with. */
	let runEnd: string | null = null
	return {
		record(before, after, typed) {
			const continuesRun = typed !== null && runEnd === before.value && !/\s/u.test(typed)
			if (!continuesRun) {
				items.push(before)
				if (items.length > limit) items.shift()
			}
			runEnd = typed !== null && !/\s/u.test(typed) ? after : null
		},
		undo() {
			runEnd = null
			return items.pop()
		},
		clear() {
			items.length = 0
			runEnd = null
		},
		get size() {
			return items.length
		},
	}
}
