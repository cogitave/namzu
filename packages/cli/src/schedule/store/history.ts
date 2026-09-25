/**
 * `schedule/history/<job-id>.jsonl`: one JSON record per line, appended with
 * a single `write` on an `O_APPEND` descriptor. Lines stay under 4 KiB, so an
 * append is atomic on a local POSIX file system and two writers never
 * interleave inside a line. A run's later status is a NEW record with the
 * same `runId`; the last one wins, and nothing is rewritten in place except by
 * compaction.
 */

import { closeSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SchedulePaths } from '../paths.js'
import {
	SCHEDULE_FORMAT_VERSION,
	SCHEDULE_FORMAT_VERSION_LEGACY,
	type ScheduleHistoryRecord,
} from '../types.js'
import { PRIVATE_FILE_MODE, ensureDir } from './atomic.js'

const MAX_LINE = 4_000
const KEEP_RECORDS = 500
const KEEP_MS = 180 * 24 * 60 * 60 * 1000

/** A model-produced string trimmed so a record fits one atomic line. */
function fit(record: ScheduleHistoryRecord): string {
	let line = JSON.stringify(record)
	if (line.length <= MAX_LINE) return line
	if (record.kind === 'run') {
		const trimmed = {
			...record,
			...(record.summary ? { summary: record.summary.slice(0, 200) } : {}),
			...(record.reason ? { reason: record.reason.slice(0, 1_000) } : {}),
			...(record.warnings
				? { warnings: record.warnings.slice(0, 3).map((w) => w.slice(0, 300)) }
				: {}),
		}
		line = JSON.stringify(trimmed)
	}
	return line.length <= MAX_LINE
		? line
		: JSON.stringify({ ...record, detail: undefined, reason: 'record too long' })
}

export function appendHistory(
	paths: SchedulePaths,
	jobId: string,
	record: ScheduleHistoryRecord,
): void {
	const path = paths.historyOf(jobId)
	ensureDir(dirname(path))
	const fd = openSync(path, 'a', PRIVATE_FILE_MODE)
	try {
		writeSync(fd, `${fit(record)}\n`)
	} finally {
		closeSync(fd)
	}
}

/** Every readable record, oldest first. A torn or foreign line is skipped. */
export function readHistory(paths: SchedulePaths, jobId: string): ScheduleHistoryRecord[] {
	let text: string
	try {
		text = readFileSync(paths.historyOf(jobId), 'utf8')
	} catch {
		return []
	}
	const out: ScheduleHistoryRecord[] = []
	for (const line of text.split('\n')) {
		if (!line.trim()) continue
		try {
			const record = JSON.parse(line) as ScheduleHistoryRecord
			if (
				record &&
				(record.v === SCHEDULE_FORMAT_VERSION_LEGACY || record.v === SCHEDULE_FORMAT_VERSION) &&
				typeof record.kind === 'string'
			)
				out.push(record)
		} catch {}
	}
	return out
}

/**
 * Runs folded by `runId` (the last record of each wins), plus the other
 * records, newest first.
 */
export function foldHistory(records: readonly ScheduleHistoryRecord[]): ScheduleHistoryRecord[] {
	const runs = new Map<string, number>()
	const out: ScheduleHistoryRecord[] = []
	for (const record of records) {
		if (record.kind === 'run') {
			const at = runs.get(record.runId)
			if (at !== undefined) {
				out[at] = record
				continue
			}
			runs.set(record.runId, out.length)
		}
		out.push(record)
	}
	return out.reverse()
}

/** Keep the last 500 records or 180 days, whichever is more. Returns how many were dropped. */
export function compactHistory(paths: SchedulePaths, jobId: string, now = Date.now()): number {
	const path = paths.historyOf(jobId)
	try {
		if (statSync(path).size < 256 * 1024) return 0
	} catch {
		return 0
	}
	const records = readHistory(paths, jobId)
	const keepFrom = Math.max(0, records.length - KEEP_RECORDS)
	const kept = records.filter((r, i) => i >= keepFrom || now - Date.parse(r.at) <= KEEP_MS)
	if (kept.length === records.length) return 0
	const temporary = `${path}.${process.pid}.compact`
	const fd = openSync(temporary, 'w', PRIVATE_FILE_MODE)
	try {
		writeSync(fd, kept.map((r) => `${JSON.stringify(r)}\n`).join(''))
	} finally {
		closeSync(fd)
	}
	renameSync(temporary, path)
	return records.length - kept.length
}
