/**
 * The command that opens a scheduled run's conversation, for every place that
 * tells the operator how to answer a park.
 *
 * Conversations are stored per folder, so `namzu resume <id>` finds a run's
 * conversation only from the job's folder; anywhere else it says "not found".
 * The command therefore always carries the folder, and the job's extra roots,
 * which a session answering the park must have. Every path is quoted for a
 * POSIX shell.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { schedulePaths } from './paths.js'
import { foldHistory, readHistory } from './store/history.js'
import { listJobs } from './store/jobs.js'
import { readState } from './store/state.js'
import type { ScheduleJob } from './types.js'

/** A word as a POSIX shell reads it back: bare when safe, else single-quoted. */
export function shellQuote(value: string): string {
	return /^[A-Za-z0-9._/@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** `cd <folder> && namzu [--add-dir <dir>]… resume <session-id>`. */
export function resumeCommand(
	job: Pick<ScheduleJob, 'folder' | 'permissions'>,
	sessionId: string,
): string {
	const addDirs = (job.permissions.additionalDirectories ?? [])
		.map((dir) => ` --add-dir ${shellQuote(dir)}`)
		.join('')
	return `cd ${shellQuote(job.folder.canonical)} && namzu${addDirs} resume ${shellQuote(sessionId)}`
}

function canonical(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return resolve(path)
	}
}

/**
 * The scheduled job whose run owns `sessionId`, when that conversation lives
 * in another folder than `cwd`: what `namzu resume <id>` says instead of a
 * bare "not found". Reads the job store only; never throws.
 */
export function scheduledSessionElsewhere(
	home: string,
	sessionId: string,
	cwd: string,
): { readonly job: ScheduleJob; readonly command: string } | undefined {
	try {
		const paths = schedulePaths(home)
		const here = canonical(cwd)
		for (const job of listJobs(paths).jobs) {
			if (job.folder.canonical === here) continue
			const state = readState(paths, job.id)
			const owns =
				state.activeRun?.sessionId === sessionId ||
				state.lastRun?.sessionId === sessionId ||
				foldHistory(readHistory(paths, job.id)).some(
					(record) => record.kind === 'run' && record.sessionId === sessionId,
				)
			if (owns) return { job, command: resumeCommand(job, sessionId) }
		}
	} catch {
		// A job store that cannot be read says nothing; the ordinary refusal stands.
	}
	return undefined
}
