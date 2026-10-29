/**
 * The words on the reasoning row. The label gets more patient the longer one
 * stretch of reasoning runs, and when it ends the row says how long it took
 * for two seconds. Pure; the clock is passed in.
 */

import { useEffect, useRef, useState } from 'react'

const STILL_AFTER_MS = 10_000
const MORE_AFTER_MS = 20_000
const SOME_MORE_AFTER_MS = 30_000
const DEEP_AFTER_MS = 45_000
/** How long `thought for 12s` stays up once the reasoning has ended. */
export const SETTLED_SHOWN_MS = 2_000

/** The label for a stretch of reasoning that has run `ms` so far. */
export function thinkingLabel(ms: number): string {
	if (ms >= DEEP_AFTER_MS) return 'deep in thought'
	if (ms >= SOME_MORE_AFTER_MS) return 'thinking some more'
	if (ms >= MORE_AFTER_MS) return 'thinking more'
	if (ms >= STILL_AFTER_MS) return 'still thinking'
	return 'thinking'
}

/** The settled row for a stretch that lasted `ms`: whole seconds, never less than one. */
export function thoughtForLabel(ms: number): string {
	return `thought for ${Math.max(1, Math.round(ms / 1000))}s`
}

export interface ThinkingRow {
	/** The live label while reasoning runs, else `null`. */
	readonly live: string | null
	/** `thought for Ns`, for two seconds after a stretch ends, else `null`. */
	readonly settled: string | null
}

/**
 * Follows one turn's reasoning. `reasoning` is true while the model is
 * thinking and no tool runs (a tool ends the stretch). Call it every render;
 * it schedules the one redraw that clears the settled row.
 */
export function useThinkingRow(reasoning: boolean, active: boolean): ThinkingRow {
	const state = useRef<{ start: number | null; settled: { ms: number; until: number } | null }>({
		start: null,
		settled: null,
	})
	const [, redraw] = useState(0)
	const now = Date.now()
	const s = state.current
	if (!active) {
		s.start = null
		s.settled = null
	} else if (reasoning) {
		if (s.start === null) s.start = now
		s.settled = null
	} else if (s.start !== null) {
		s.settled = { ms: now - s.start, until: now + SETTLED_SHOWN_MS }
		s.start = null
	}
	if (s.settled !== null && now >= s.settled.until) s.settled = null
	const until = s.settled?.until ?? null
	useEffect(() => {
		if (until === null) return
		const timer = setTimeout(() => redraw((n) => n + 1), Math.max(0, until - Date.now()))
		return () => clearTimeout(timer)
	}, [until])
	return {
		live: reasoning && s.start !== null ? thinkingLabel(now - s.start) : null,
		settled: s.settled ? thoughtForLabel(s.settled.ms) : null,
	}
}
