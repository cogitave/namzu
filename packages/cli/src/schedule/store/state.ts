/**
 * `schedule/state/<job-id>.json`: what the daemon remembers about a job
 * between evaluations. The daemon is its only writer (one daemon owns a home
 * at a time, by lease), so a plain replace is enough.
 */

import type { SchedulePaths } from '../paths.js'
import type { ScheduleJobState } from '../types.js'
import { readVersioned, writeJsonAtomic } from './atomic.js'

export function emptyState(jobId: string): ScheduleJobState {
	return {
		v: 1,
		kind: 'schedule-state',
		jobId,
		counters: { runs: 0, failures: 0, failureStreak: 0 },
	}
}

export function readState(paths: SchedulePaths, jobId: string): ScheduleJobState {
	return (
		readVersioned<ScheduleJobState>(paths.stateOf(jobId), 'schedule-state') ?? emptyState(jobId)
	)
}

export function writeState(paths: SchedulePaths, state: ScheduleJobState): void {
	writeJsonAtomic(paths.stateOf(state.jobId), state)
}

/** Drop optional keys whose value is undefined, so a spread can remove a field. */
export function withoutUndefined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}
