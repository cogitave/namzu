import type { ThreadState, TimelineEntry } from '../shared/projection.js'
import { isTaskEntry } from './plan-row.js'
import type { TranscriptTurn } from './transcript-layout.js'

/**
 * Parts of the thread no turn's rows read (a turn holding the plan is checked for `tasks` below). A change to one of these never redraws a turn. Anything
 * not named here (a field added later included) is compared, so the safe answer is the default.
 */
const unreadByTurns: ReadonlySet<keyof ThreadState> = new Set([
	'revision',
	'tasks',
	'responding',
	'activeReasoningId',
	'queued',
	'queuedItems',
	'liveInputs',
	'liveInputSupported',
	'retry',
	'retryNotice',
	'result',
	'partial',
	'historyWorkPartial',
])
/** Looked up per entry (a tool's activity check reads the timeline for its own entry only), so only the entries a turn names are compared. */
const readPerEntry: ReadonlySet<keyof ThreadState> = new Set([
	'messages',
	'tools',
	'reasoning',
	'turns',
	'timeline',
])

function sameEntries(a: TimelineEntry[], b: TimelineEntry[]): boolean {
	return a.length === b.length && a.every((entry, index) => entry === b[index])
}

function entriesOf(group: TranscriptTurn): TimelineEntry[][] {
	return group.segments.flatMap((segment) => [segment.user, segment.activity, segment.answer])
}

/** Whether a turn's rows would be drawn from exactly the same data in `next` as in `previous`. */
export function turnInputsUnchanged(
	previous: { thread: ThreadState; group: TranscriptTurn },
	next: { thread: ThreadState; group: TranscriptTurn },
): boolean {
	const before = previous.thread
	const after = next.thread
	for (const key of Object.keys(after) as (keyof ThreadState)[]) {
		if (unreadByTurns.has(key) || readPerEntry.has(key)) continue
		if (before[key] !== after[key]) return false
	}
	for (const key of Object.keys(before) as (keyof ThreadState)[])
		if (!(key in after) && !unreadByTurns.has(key) && !readPerEntry.has(key)) return false
	if (previous.group.turn !== next.group.turn) return false
	// Only a turn that holds the plan draws it.
	if (
		before.tasks !== after.tasks &&
		entriesOf(next.group).some((list) => list.some((entry) => isTaskEntry(after, entry)))
	)
		return false
	if (before.turns[next.group.turn] !== after.turns[next.group.turn]) return false
	const left = entriesOf(previous.group)
	const right = entriesOf(next.group)
	if (left.length !== right.length) return false
	for (let index = 0; index < left.length; index++) {
		const a = left[index] as TimelineEntry[]
		const b = right[index] as TimelineEntry[]
		if (!sameEntries(a, b)) return false
		for (const entry of b) {
			if (entry.kind === 'message') {
				if (before.messages[entry.index] !== after.messages[entry.index]) return false
			} else if (entry.kind === 'tool') {
				if (before.tools[entry.id] !== after.tools[entry.id]) return false
			} else if (before.reasoning[entry.id] !== after.reasoning[entry.id]) return false
		}
	}
	return true
}
