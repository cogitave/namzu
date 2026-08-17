import type { TranscriptMessage } from './types.js'

/**
 * Which transcript rows survive a compaction pass.
 *
 * The pass returns a MESSAGE list — system, a summary, and the recent turns.
 * The transcript is not that list: it also holds tool rows, per-tool glyphs and
 * collapsed bodies, none of which the model ever saw. Rebuilding the transcript
 * from the returned messages would produce a correct conversation and throw
 * away the rendering of every turn that was kept.
 *
 * So the transcript is TRIMMED to match instead, by counting user and assistant
 * rows from the end until `keptTurns` of them have been seen. Everything from
 * that row onward stays, tool rows included — they belong to turns that
 * survived, and dropping them would leave an answer on screen with no visible
 * cause.
 *
 * Counting from the END rather than the start is what makes this robust to the
 * transcript and the message list disagreeing about the beginning: a system
 * row, an earlier summary, a `/status` readout are all rows the model was never
 * sent, and any index computed from the front would be off by however many of
 * them exist.
 */
export function keepRecentRows(
	rows: readonly TranscriptMessage[],
	keptTurns: number,
): readonly TranscriptMessage[] {
	// A pass that kept nothing keeps nothing. Guarded rather than left to the
	// loop, which would return the whole transcript for a zero — the opposite
	// of what was asked, and silently.
	if (keptTurns <= 0) return []

	// The index of the Nth-from-last turn row, stated directly.
	//
	// An earlier version walked backwards extending the kept range and stopped
	// only on seeing a turn row too many — which never happens when the rows
	// ahead of the surviving turns are all system rows, so a previous summary
	// and a `/status` readout were dragged back in. Its own test caught it.
	let seen = 0
	for (let i = rows.length - 1; i >= 0; i -= 1) {
		const row = rows[i]
		if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue
		seen += 1
		if (seen === keptTurns) return rows.slice(i)
	}
	// Fewer turns exist than the pass kept: nothing to trim.
	return rows
}
