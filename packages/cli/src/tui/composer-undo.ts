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
import type { MessageAttachment } from '@namzu/sdk'
import type { Span } from './triggers/provenance.js'

export const UNDO_LIMIT = 50

export interface DraftSnapshot {
	readonly value: string
	readonly cursor: number
	readonly spans: readonly Span[]
	/** What was attached, so an undone delete brings its image back with its marker. */
	readonly attachments?: readonly MessageAttachment[]
}

export interface UndoStack {
	/**
	 * Save `before` ahead of an edit that produces `after`. `typed` says the
	 * edit is one typed character; a run of those saves one snapshot.
	 */
	record(before: DraftSnapshot, after: string, typed: string | null): void
	/** The draft before the latest edit, which is then forgotten; undefined when there is none. */
	undo(): DraftSnapshot | undefined
	/** End the run of typed letters, so the next edit is an edit of its own. */
	breakRun(): void
	/** How many drafts were ever saved; unlike `size` it keeps counting once the stack is full. */
	readonly saved: number
	/**
	 * Fold the drafts saved since `saved` was `mark` into the first of them, so a
	 * whole insert undoes in one step, also when the stack was full and dropping
	 * its oldest drafts as the insert went on.
	 */
	collapseSince(mark: number): void
	/** Forget everything, as after a send. */
	clear(): void
	readonly size: number
}

export function createUndoStack(limit: number = UNDO_LIMIT): UndoStack {
	const items: DraftSnapshot[] = []
	/** The draft a still-open run of typed letters ended with. */
	let runEnd: string | null = null
	let saved = 0
	return {
		record(before, after, typed) {
			const continuesRun = typed !== null && runEnd === before.value && !/\s/u.test(typed)
			if (!continuesRun) {
				items.push(before)
				saved += 1
				if (items.length > limit) items.shift()
			}
			runEnd = typed !== null && !/\s/u.test(typed) ? after : null
		},
		undo() {
			runEnd = null
			return items.pop()
		},
		breakRun() {
			runEnd = null
		},
		collapseSince(mark) {
			const added = saved - mark
			if (added > 1) items.length = Math.max(0, items.length - (added - 1))
			runEnd = null
		},
		clear() {
			items.length = 0
			runEnd = null
		},
		get saved() {
			return saved
		},
		get size() {
			return items.length
		},
	}
}
