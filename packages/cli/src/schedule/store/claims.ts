/**
 * `schedule/claims/<job-id>/<key>.json`: one per occurrence ever started.
 *
 * Published with `link` when the run is DISPATCHED — not when it is queued —
 * so a daemon that restarts while a run waits for a slot re-derives it and
 * runs it once, and a second daemon (or a backward clock) can never start an
 * occurrence that already started. This file is the final once-only
 * guarantee, independent of the daemon lease.
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SchedulePaths } from '../paths.js'
import { publishExclusive, readVersioned } from './atomic.js'

export interface ScheduleClaim {
	readonly v: 1
	readonly kind: 'schedule-claim'
	readonly jobId: string
	readonly key: string
	readonly runId: string
	readonly daemonEpoch: string
	readonly at: string
}

/** `true` when this call started the occurrence; `false` when it was already started. */
export function claimOccurrence(
	paths: SchedulePaths,
	claim: Omit<ScheduleClaim, 'v' | 'kind'>,
): boolean {
	if (!/^(\d{1,16}|manual-[0-9a-f-]{8,64})$/.test(claim.key)) {
		throw new Error(
			`Refusing an occurrence key that is not an instant or a manual run: ${claim.key}`,
		)
	}
	return publishExclusive(paths.claim(claim.jobId, claim.key), {
		v: 1,
		kind: 'schedule-claim',
		...claim,
	})
}

export function readClaim(
	paths: SchedulePaths,
	jobId: string,
	key: string,
): ScheduleClaim | undefined {
	return readVersioned<ScheduleClaim>(paths.claim(jobId, key), 'schedule-claim', 1)
}

export function isClaimed(paths: SchedulePaths, jobId: string, key: string): boolean {
	try {
		statSync(paths.claim(jobId, key))
		return true
	} catch {
		return false
	}
}

/** Remove claims older than `maxAgeMs` (nothing that old can be due again). */
export function pruneClaims(
	paths: SchedulePaths,
	jobId: string,
	maxAgeMs: number,
	now = Date.now(),
): number {
	let removed = 0
	let names: string[]
	try {
		names = readdirSync(paths.claimsOf(jobId))
	} catch {
		return 0
	}
	for (const name of names) {
		const match = /^(\d{1,16})\.json$/.exec(name)
		if (!match) continue
		if (now - Number(match[1]) > maxAgeMs) {
			rmSync(join(paths.claimsOf(jobId), name), { force: true })
			removed++
		}
	}
	return removed
}
