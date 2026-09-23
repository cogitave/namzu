/**
 * Every run is its own session, and a job every minute would leave 1 440 a
 * day in the folder's `/resume` list. After each completed run the daemon
 * ARCHIVES (never deletes) this job's completed-run sessions beyond the
 * newest `retention.keepSessions` — `session_updated{ archived: true }`, the
 * same read-only tombstone `/archive` writes. Parked, failed and interrupted
 * runs are never archived here. `namzu schedule prune` is the only thing that
 * deletes.
 */

import { asSessionId } from '@namzu/sdk'
import {
	archiveConversation,
	closeSessions,
	openSessions,
} from '../../integrations/sessions/store.js'
import type { SchedulePaths } from '../paths.js'
import { foldHistory, readHistory } from '../store/history.js'
import type { ScheduleJob, ScheduleJobState } from '../types.js'

/** The session ids retention would archive now. */
export function sessionsToArchive(
	paths: SchedulePaths,
	job: ScheduleJob,
	state: Pick<ScheduleJobState, 'archivedSessions'>,
): string[] {
	const done = new Set(state.archivedSessions ?? [])
	const completed = foldHistory(readHistory(paths, job.id)).filter(
		(r): r is Extract<typeof r, { kind: 'run' }> =>
			r.kind === 'run' && r.status === 'completed' && typeof r.sessionId === 'string',
	)
	return completed
		.slice(Math.max(0, job.retention.keepSessions))
		.map((r) => r.sessionId as string)
		.filter((id) => !done.has(id))
}

/** Archive what retention allows. Returns the ids archived (or already archived). */
export async function archiveOldRuns(
	paths: SchedulePaths,
	job: ScheduleJob,
	state: Pick<ScheduleJobState, 'archivedSessions'>,
): Promise<string[]> {
	const ids = sessionsToArchive(paths, job, state)
	if (ids.length === 0) return []
	const sessions = await openSessions(job.folder.canonical, { stateRoot: paths.home })
	const archived: string[] = []
	try {
		for (const id of ids) {
			try {
				await archiveConversation(sessions, asSessionId(id))
				archived.push(id)
			} catch (error) {
				if (error instanceof Error && /already archived/.test(error.message)) archived.push(id)
			}
		}
	} finally {
		closeSessions(sessions)
	}
	return archived
}
