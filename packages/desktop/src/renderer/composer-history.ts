/**
 * Recalling earlier messages in the message box with the arrow keys. The box walks back through
 * what was sent in this conversation, keeps whatever was being typed, and gives it back when the
 * walk comes down past the newest message.
 */

/** The most messages the walk goes back through. */
export const HISTORY_LIMIT = 100

/** Where a walk through the history stands. `recalled` is what the box shows because of it. */
export interface HistoryWalk {
	/** Position in the entries, oldest first. */
	index: number
	/** What was in the box when the walk began. */
	stash: string
	recalled: string
}

/**
 * The messages the person sent, oldest first: empty ones dropped, a message sent twice in a row
 * kept once, and only the newest few kept.
 */
export function historyEntries(
	messages: readonly { role: 'user' | 'assistant'; text: string }[],
): string[] {
	const entries: string[] = []
	for (const message of messages) {
		if (message.role !== 'user' || message.text.trim().length === 0) continue
		if (entries.at(-1) === message.text) continue
		entries.push(message.text)
	}
	return entries.slice(-HISTORY_LIMIT)
}

/** The walk only counts while the box still shows what the walk put there. */
export function activeWalk(walk: HistoryWalk | null, draft: string): HistoryWalk | null {
	return walk && walk.recalled === draft ? walk : null
}

export interface HistoryStep {
	walk: HistoryWalk | null
	text: string
}

/**
 * One step along the walk, or null when there is nowhere to go (no history, already at the oldest
 * message, or coming down with no walk under way) and the arrow key should do its usual job.
 */
export function stepHistory(
	entries: readonly string[],
	walk: HistoryWalk | null,
	draft: string,
	direction: 'older' | 'newer',
): HistoryStep | null {
	const active = activeWalk(walk, draft)
	if (direction === 'older') {
		if (entries.length === 0) return null
		if (!active) {
			const index = entries.length - 1
			const text = entries[index] ?? ''
			return { walk: { index, stash: draft, recalled: text }, text }
		}
		if (active.index === 0) return null
		const index = active.index - 1
		const text = entries[index] ?? ''
		return { walk: { ...active, index, recalled: text }, text }
	}
	if (!active) return null
	if (active.index >= entries.length - 1) return { walk: null, text: active.stash }
	const index = active.index + 1
	const text = entries[index] ?? ''
	return { walk: { ...active, index, recalled: text }, text }
}

/** "Earlier message 2 of 5", counted back from the newest. */
export function historyCounter(walk: HistoryWalk, total: number): string {
	return `Earlier message ${total - walk.index} of ${total}`
}

/**
 * Whether the caret sits where an arrow key should leave the text and move through the history:
 * nothing selected, and at the very start going up or the very end going down. A message is often
 * one long paragraph that wraps over several rows, and the text cannot tell which row the caret is
 * on, so anywhere else the key stays with the box and moves the caret a row, whatever the line
 * breaks are. Recalling an earlier message puts the caret at its start and recalling a newer one at
 * its end, so a run of the same key keeps walking. Moving up from the first line of text somebody
 * typed would throw their words away for a stray key, so an empty box or the very start is where a
 * walk begins.
 */
export function caretAtEdge(
	value: string,
	selectionStart: number,
	selectionEnd: number,
	direction: 'older' | 'newer',
): boolean {
	if (selectionStart !== selectionEnd) return false
	return direction === 'older' ? selectionStart === 0 : selectionEnd === value.length
}

/** Where the caret goes once a step along the walk has put its text in the box. */
export function caretAfterStep(text: string, direction: 'older' | 'newer'): number {
	return direction === 'older' ? 0 : text.length
}
