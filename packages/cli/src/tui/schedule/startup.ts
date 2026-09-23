/**
 * The one line the TUI prints on open about scheduled work since it last
 * looked: runs that finished or failed, runs waiting for approval, jobs on
 * hold or paused by failures, a scheduler that is not installed or not
 * running, a run working in this folder right now. Nothing when there is
 * nothing to say. Reads are bounded (each job's history tail), and the caller
 * gives it a time budget so a slow disk never delays the first paint.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { takeSuppressedCount } from '../../integrations/notifications/desktop/throttle.js'
import { schedulePaths } from '../../schedule/paths.js'
import { readManifest } from '../../schedule/service/manifest.js'
import { writeJsonAtomic } from '../../schedule/store/atomic.js'
import { readHistory } from '../../schedule/store/history.js'
import { confirmationHolds, listJobs } from '../../schedule/store/jobs.js'
import { readState } from '../../schedule/store/state.js'

function ago(ms: number): string {
	if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`
	if (ms < 172_800_000) return `${Math.round(ms / 3_600_000)} h`
	return `${Math.round(ms / 86_400_000)} d`
}

/** Compute the line and record that it was shown. `undefined` when there is nothing to say. */
export function scheduleStartupLine(
	home: string,
	cwd: string,
	now = Date.now(),
): string | undefined {
	const paths = schedulePaths(home)
	const { jobs } = listJobs(paths)
	if (jobs.length === 0) return undefined
	let since = now - 24 * 3_600_000
	try {
		const seen = JSON.parse(readFileSync(paths.seen, 'utf8')) as { lastSummaryAt?: string }
		if (seen.lastSummaryAt) since = Date.parse(seen.lastSummaryAt)
	} catch {}
	const parts: string[] = []
	let finished = 0
	const failed: string[] = []
	const waiting: string[] = []
	const held: string[] = []
	const failingPaused: string[] = []
	const hereNow: string[] = []
	for (const job of jobs) {
		const state = readState(paths, job.id)
		if (state.activeRun?.status === 'awaiting-approval') waiting.push(job.name)
		if (state.activeRun?.status === 'running' && job.folder.canonical === cwd)
			hereNow.push(job.name)
		if (job.state === 'pending-confirmation' || (job.state === 'active' && !confirmationHolds(job)))
			held.push(job.name)
		if (job.state === 'paused' && job.pausedBy === 'auto-failure-streak')
			failingPaused.push(job.name)
		for (const record of readHistory(paths, job.id).slice(-200)) {
			if (record.kind !== 'run' || Date.parse(record.at) <= since) continue
			if (record.status === 'completed') finished++
			else if (record.status !== 'running' && record.status !== 'awaiting-approval') {
				failed.push(
					`${job.name} ${record.status}${record.reason ? ` (${record.reason.slice(0, 60)})` : ''}`,
				)
			}
		}
	}
	if (finished + failed.length > 0 || waiting.length > 0) {
		const bits = [
			...(finished > 0 ? [`${finished} finished`] : []),
			...(failed.length > 0 ? [`${failed.length} failed: ${failed.slice(0, 2).join('; ')}`] : []),
			...(waiting.length > 0 ? [`waiting for approval: ${waiting.join(', ')}`] : []),
		]
		parts.push(`Scheduled: ${bits.join(' · ')}`)
	}
	for (const name of held) parts.push(`Scheduled: job ${name} is on hold until confirmed`)
	for (const name of failingPaused)
		parts.push(`Scheduled: job ${name} paused after repeated failures`)
	if (hereNow.length > 0)
		parts.push(`A scheduled run (${hereNow.join(', ')}) is working in this folder now`)
	const active = jobs.some((j) => j.state === 'active')
	let manifest: ReturnType<typeof readManifest>
	try {
		manifest = readManifest(paths)
	} catch {
		manifest = undefined
	}
	if (active && !manifest) {
		parts.push('Scheduled jobs exist but the scheduler is not installed — namzu schedule install')
	} else if (manifest) {
		try {
			const beat = JSON.parse(readFileSync(paths.heartbeat, 'utf8')) as { at?: string }
			const age = beat.at ? now - Date.parse(beat.at) : Number.POSITIVE_INFINITY
			if (age > 90_000)
				parts.push(
					`The scheduler is installed but not running (last seen ${ago(age)} ago) — namzu schedule status`,
				)
		} catch {
			parts.push('The scheduler is installed but has not started — namzu schedule status')
		}
	}
	const suppressed = takeSuppressedCount(join(paths.daemon, 'notify.json'))
	if (suppressed > 0) parts.push(`${suppressed} scheduled notification(s) were held back`)
	try {
		writeJsonAtomic(paths.seen, {
			v: 1,
			kind: 'schedule-seen',
			lastSummaryAt: new Date(now).toISOString(),
		})
	} catch {}
	return parts.length > 0 ? `${parts.join('. ')}. /schedule` : undefined
}
