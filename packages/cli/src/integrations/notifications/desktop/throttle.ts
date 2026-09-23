/**
 * At most one notification per job every ten minutes and twenty a day in
 * all; what is held back is counted, for the TUI's next startup line.
 * Kept in `schedule/daemon/notify.json`, written only by the daemon.
 */

import { readFileSync } from 'node:fs'
import { writeJsonAtomic } from '../../../schedule/store/atomic.js'

const PER_JOB_MS = 10 * 60_000
const PER_DAY = 20
const DAY_MS = 24 * 60 * 60_000

interface ThrottleFile {
	readonly v: 1
	readonly kind: 'schedule-notify'
	readonly sent: readonly { readonly jobId: string; readonly at: number }[]
	readonly suppressed: number
}

function read(path: string): ThrottleFile {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as ThrottleFile
		if (parsed.kind === 'schedule-notify' && Array.isArray(parsed.sent)) return parsed
	} catch {}
	return { v: 1, kind: 'schedule-notify', sent: [], suppressed: 0 }
}

/** Whether a notification for `jobId` may go out now; records it when it may. */
export function admitNotification(path: string, jobId: string, now = Date.now()): boolean {
	const file = read(path)
	const recent = file.sent.filter((s) => now - s.at < DAY_MS)
	const jobRecent = recent.some((s) => s.jobId === jobId && now - s.at < PER_JOB_MS)
	if (jobRecent || recent.length >= PER_DAY) {
		writeJsonAtomic(path, { ...file, sent: recent, suppressed: file.suppressed + 1 })
		return false
	}
	writeJsonAtomic(path, { ...file, sent: [...recent, { jobId, at: now }] })
	return true
}

/** How many notifications were held back since the count was last taken; resets it. */
export function takeSuppressedCount(path: string): number {
	const file = read(path)
	if (file.suppressed > 0) writeJsonAtomic(path, { ...file, suppressed: 0 })
	return file.suppressed
}
