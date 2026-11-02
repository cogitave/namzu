import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { BackgroundJobRegistry } from '../registry.js'

/**
 * Stopping a job also stops what it started in a session of its own.
 *
 * The process group is the job, and `setsid` leaves it: a descendant that
 * starts a new session has no group to signal, so the group kill used to leave
 * it running with nothing that could name it. The shell is tagged through its
 * environment, which every descendant inherits however it was started, and the
 * kill signals whatever carries the tag. Real processes, because a mock proves
 * only that a call was made.
 */

/** Gone, or a zombie waiting to be reaped: either way it is not running. */
function stopped(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
		return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')
	} catch {
		return true
	}
}

function withMarker(marker: string): number[] {
	const found: number[] = []
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue
		try {
			const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf-8').replaceAll('\0', ' ')
			if (cmdline.includes(marker)) found.push(Number(entry))
		} catch {
			// gone between the listing and the read
		}
	}
	return found
}

describe.skipIf(process.platform !== 'linux')(
	'a killed job leaves nothing in a session of its own',
	() => {
		it('stops a setsid descendant along with the group', async () => {
			const registry = new BackgroundJobRegistry()
			const marker = 'sleep 7203'
			const job = registry.start({
				owner: 'o',
				command: `setsid ${marker} & ${marker}`,
				workingDirectory: process.cwd(),
			})
			await registry.awaitStarted(job.id)
			// Both sleeps exist once the shell has forked them; wait for the event.
			while (withMarker(marker).filter((pid) => !stopped(pid)).length < 2) {
				await new Promise((resolve) => setImmediate(resolve))
			}
			const pids = withMarker(marker)

			await registry.kill(job.id)

			for (const pid of pids)
				while (!stopped(pid)) await new Promise((resolve) => setImmediate(resolve))
			expect(pids.every(stopped)).toBe(true)
		}, 30_000)
	},
)
