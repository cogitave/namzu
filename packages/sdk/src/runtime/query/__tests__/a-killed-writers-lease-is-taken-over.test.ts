import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { DiskSessionLog, leaseHolderProcessIsGone } from '../../../store/session-log/index.js'
import { generateSessionId } from '../../../utils/id.js'
import { withSessionLease } from '../abandon-turn.js'

/**
 * A writer killed outright cannot give its lease back. Its session is not
 * shut out for the lease's whole time-to-live when the process is certainly
 * gone from this machine; a live process, or a holder that cannot be judged,
 * still keeps it.
 */

const made: string[] = []
afterAll(async () => {
	await removeTempDirs(made.splice(0))
})

/** A pid that existed a moment ago and is gone now. */
function deadPid(): number {
	const child = spawnSync(process.execPath, ['-e', ''])
	if (child.pid === undefined) throw new Error('could not start a process')
	return child.pid
}

const lease = (holder: string) => ({ holder, fence: 1, expiresAt: Date.now() + 60_000 })

describe('leaseHolderProcessIsGone', () => {
	it('is true only for a turn-named holder whose pid does not exist', () => {
		expect(leaseHolderProcessIsGone(lease(`namzu:${deadPid()}:turn`))).toBe(true)
		expect(leaseHolderProcessIsGone(lease(`namzu:${process.pid}:turn`))).toBe(false)
		expect(leaseHolderProcessIsGone(lease('protocol-host'))).toBe(false)
		expect(leaseHolderProcessIsGone(lease(''))).toBe(false)
		expect(leaseHolderProcessIsGone(null)).toBe(false)
	})
})

describe('withSessionLease', () => {
	it('takes the session over from a dead writer, and refuses a live one', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-dead-writer-')))
		made.push(root)
		const open = (sessionId: ReturnType<typeof generateSessionId>) =>
			new DiskSessionLog({
				sessionId,
				file: join(root, `${sessionId}.jsonl`),
				sessionDir: join(root, sessionId),
			})

		const gone = generateSessionId()
		expect(await open(gone).claim({ holder: `namzu:${deadPid()}:t`, ttlMs: 5 * 60_000 })).not.toBe(
			null,
		)
		await expect(withSessionLease(open(gone), undefined, async () => 'closed')).resolves.toBe(
			'closed',
		)

		const alive = generateSessionId()
		expect(
			await open(alive).claim({ holder: `namzu:${process.pid}:t`, ttlMs: 5 * 60_000 }),
		).not.toBe(null)
		await expect(withSessionLease(open(alive), undefined, async () => 'closed')).rejects.toThrow(
			/live writer/,
		)
	})
})
