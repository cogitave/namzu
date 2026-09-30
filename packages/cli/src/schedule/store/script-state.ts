/**
 * Scheduler-owned opaque state for a pure script's next poll. The script
 * reads a snapshot and proposes `nextState` in its durable run result; only
 * the scheduler writes this file after handling that result. A state revision
 * prevents a delayed result from rolling back a later poll's state.
 */

import { join } from 'node:path'
import { MAX_SCRIPT_STATE_BYTES, isWellFormedScriptState } from '../fire/script-report.js'
import type { SchedulePaths } from '../paths.js'
import { readVersioned, writeJsonAtomic } from './atomic.js'

const UUID =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/

/** `revision` is the script state revision, separate from the job definition. */
export interface ScriptStateSnapshot {
	readonly revision: number
	readonly state: string
	readonly lastRunId?: string
}

interface StoredScriptState extends ScriptStateSnapshot {
	readonly v: 1
	readonly kind: 'schedule-script-state'
	readonly jobId: string
	readonly lastRunId: string
}

export type ScriptStateWrite =
	| { readonly kind: 'written' | 'already-applied'; readonly snapshot: ScriptStateSnapshot }
	| { readonly kind: 'conflict'; readonly snapshot: ScriptStateSnapshot }

function checkedId(value: string, label: string): string {
	if (!UUID.test(value)) throw new Error(`invalid ${label}: expected a UUID`)
	return value
}

/** A private file under the scheduler root; resolving it does not create it. */
export function scriptStatePath(paths: SchedulePaths, jobId: string): string {
	return join(paths.root, 'script-state', `${checkedId(jobId, 'job id')}.json`)
}

function validate(value: StoredScriptState, jobId: string): ScriptStateSnapshot {
	if (
		value.v !== 1 ||
		value.kind !== 'schedule-script-state' ||
		value.jobId !== jobId ||
		!Number.isSafeInteger(value.revision) ||
		value.revision < 1 ||
		typeof value.state !== 'string' ||
		value.state.includes('\0') ||
		!isWellFormedScriptState(value.state) ||
		Buffer.byteLength(value.state, 'utf8') > MAX_SCRIPT_STATE_BYTES ||
		!UUID.test(value.lastRunId) ||
		Object.keys(value).some(
			(key) => !['v', 'kind', 'jobId', 'revision', 'state', 'lastRunId'].includes(key),
		)
	)
		throw new Error(`script state for job ${jobId} is invalid`)
	return {
		revision: value.revision,
		state: value.state,
		...(value.lastRunId ? { lastRunId: value.lastRunId } : {}),
	}
}

/** Absence means no state has been committed yet, not a missing job. */
export function readScriptState(paths: SchedulePaths, jobId: string): ScriptStateSnapshot {
	const file = scriptStatePath(paths, jobId)
	const stored = readVersioned<StoredScriptState>(file, 'schedule-script-state', 1)
	return stored ? validate(stored, jobId) : { revision: 0, state: '' }
}

/**
 * Commit a state proposed by `runId`. The daemon is this store's only writer;
 * a repeated finalization of that run is harmless, while a result that read
 * an older revision is refused rather than replacing a newer snapshot.
 */
export function writeScriptState(
	paths: SchedulePaths,
	jobId: string,
	expectedRevision: number,
	runId: string,
	nextState: string,
): ScriptStateWrite {
	checkedId(jobId, 'job id')
	checkedId(runId, 'run id')
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
		throw new Error('invalid script state revision')
	if (nextState.includes('\0')) throw new Error('script state cannot contain NUL (U+0000)')
	if (!isWellFormedScriptState(nextState))
		throw new Error('script state must be well-formed Unicode')
	if (Buffer.byteLength(nextState, 'utf8') > MAX_SCRIPT_STATE_BYTES)
		throw new Error(`script state exceeds ${MAX_SCRIPT_STATE_BYTES} UTF-8 bytes`)
	const current = readScriptState(paths, jobId)
	if (current.lastRunId === runId) {
		if (current.state !== nextState)
			throw new Error(`run ${runId} already committed a different script state`)
		return { kind: 'already-applied', snapshot: current }
	}
	if (current.revision !== expectedRevision) return { kind: 'conflict', snapshot: current }
	const next: StoredScriptState = {
		v: 1,
		kind: 'schedule-script-state',
		jobId,
		revision: expectedRevision + 1,
		state: nextState,
		lastRunId: runId,
	}
	writeJsonAtomic(scriptStatePath(paths, jobId), next)
	return {
		kind: 'written',
		snapshot: { revision: next.revision, state: next.state, lastRunId: next.lastRunId },
	}
}
