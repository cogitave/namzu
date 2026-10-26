import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { namzuHomePath } from '../integrations/state/home.js'

/**
 * What the spinner tips need to remember between launches, kept in
 * `~/.namzu/tip-history.json` beside the other per-person records: how many
 * times the terminal has started, when each tip was last shown, and how often
 * each command has been used. A tip's cooldown counts launches, not turns, so
 * the same tip does not come back until that many starts later.
 *
 * An unreadable file reads as empty, so a damaged record costs a tip one more
 * showing and never hides one; a write that fails is dropped, because a tip is
 * not worth interrupting the composer for.
 */

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export interface TipShown {
	readonly lastLaunch: number
	readonly total: number
}

export interface TipHistory {
	readonly launches: number
	readonly shown: Readonly<Record<string, TipShown>>
	/** How many times each command was run, by name without the slash. */
	readonly used: Readonly<Record<string, number>>
}

/** The store the terminal and the picker share; the file one below is the real one. */
export interface TipHistoryStore {
	read(): TipHistory
	/** Count one process start. Called once, by the interactive entry only. */
	recordLaunch(): void
	/** A tip was picked: remember it at the current launch and count the showing. */
	recordShown(id: string): void
	/** A command ran: count it. */
	recordUse(command: string): void
}

export const EMPTY_TIP_HISTORY: TipHistory = { launches: 0, shown: {}, used: {} }

export function tipHistoryPath(home?: string): string {
	return join(namzuHomePath(home), 'tip-history.json')
}

function wholeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function readTipHistory(path: string): TipHistory {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
		if (typeof parsed !== 'object' || parsed === null) return EMPTY_TIP_HISTORY
		const raw = parsed as { launches?: unknown; shown?: unknown; used?: unknown }
		const shown: Record<string, TipShown> = {}
		if (typeof raw.shown === 'object' && raw.shown !== null) {
			for (const [id, entry] of Object.entries(raw.shown)) {
				const e = entry as { lastLaunch?: unknown; total?: unknown } | null
				if (e && wholeNumber(e.lastLaunch) && wholeNumber(e.total))
					shown[id] = { lastLaunch: e.lastLaunch, total: e.total }
			}
		}
		const used: Record<string, number> = {}
		if (typeof raw.used === 'object' && raw.used !== null) {
			for (const [name, count] of Object.entries(raw.used))
				if (wholeNumber(count)) used[name] = count
		}
		return { launches: wholeNumber(raw.launches) ? raw.launches : 0, shown, used }
	} catch {
		return EMPTY_TIP_HISTORY
	}
}

function writeTipHistory(path: string, history: TipHistory): void {
	const temp = `${path}.${randomUUID()}.tmp`
	try {
		mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
		writeFileSync(temp, `${JSON.stringify(history, null, 2)}\n`, { mode: FILE_MODE })
		renameSync(temp, path)
	} catch {
		try {
			rmSync(temp, { force: true })
		} catch {
			// nothing to clean up that we can reach
		}
	}
}

export function fileTipHistory(home?: string): TipHistoryStore {
	const path = tipHistoryPath(home)
	const update = (change: (history: TipHistory) => TipHistory): void =>
		writeTipHistory(path, change(readTipHistory(path)))
	return {
		read: () => readTipHistory(path),
		recordLaunch: () => update((h) => ({ ...h, launches: h.launches + 1 })),
		// Idempotent within a launch: a tip counts once per start, however often it is picked.
		recordShown: (id) =>
			update((h) =>
				h.shown[id]?.lastLaunch === h.launches
					? h
					: {
							...h,
							shown: {
								...h.shown,
								[id]: { lastLaunch: h.launches, total: (h.shown[id]?.total ?? 0) + 1 },
							},
						},
			),
		recordUse: (command) =>
			update((h) => ({ ...h, used: { ...h.used, [command]: (h.used[command] ?? 0) + 1 } })),
	}
}
