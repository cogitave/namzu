/**
 * `schedule/runs/<job-id>/<run-id>.json`: what a fire child leaves behind.
 * Written first when the run starts (so a session id is visible while it
 * runs) and again when it ends. The daemon finalises from this file, never
 * from an exit code alone.
 */

import type { SchedulePaths } from '../paths.js'
import { readVersioned, writeJsonAtomic } from '../store/atomic.js'
import type { ScheduleRunResult } from '../types.js'

export function writeRunResult(paths: SchedulePaths, result: ScheduleRunResult): void {
	writeJsonAtomic(paths.runResult(result.jobId, result.runId), result)
}

export function readRunResult(
	paths: SchedulePaths,
	jobId: string,
	runId: string,
): ScheduleRunResult | undefined {
	return readVersioned<ScheduleRunResult>(paths.runResult(jobId, runId), 'schedule-run-result')
}

/** Whether a result is final (the child is done with it). */
export function isFinal(result: ScheduleRunResult | undefined): boolean {
	return result !== undefined && result.status !== 'running'
}
