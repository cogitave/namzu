import type { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { killTree } from './kill-tree.js'

/**
 * The two guards, which are the only parts of this a unit test can reach.
 *
 * Whether the signal actually reaches a forked grandchild is a question
 * about a real process group, and it is answered where it can be:
 * `runtime/jobs/__tests__/a-job-outlives-its-call.proc-test.ts` starts a
 * job that forks, records the grandchild's pid and asserts it is gone.
 * That test is the reason this file does not try to prove the same thing
 * with a mock — a mocked `process.kill` proves the call was made, which is
 * the part nobody doubted.
 *
 * What IS worth pinning here is that neither guard was decorative. Both
 * failures are silent-until-they-are-not: a child that never spawned has no
 * pid, and `process.kill(-undefined)` throws; a group that already exited
 * throws ESRCH. Either one, unguarded, aborts the teardown loop that was
 * killing the REST of a run's jobs — so one dead job would strand every
 * live sibling.
 */

const child = (pid: number | undefined) => ({ pid }) as ReturnType<typeof spawn>

describe('killTree refuses to signal what it cannot name', () => {
	it('does nothing for a child with no pid', () => {
		// A spawn that failed leaves `pid` undefined. Unguarded, the negation
		// below becomes `process.kill(NaN)`, which throws.
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

		expect(() => killTree(child(undefined), 'SIGTERM')).not.toThrow()
		expect(kill).not.toHaveBeenCalled()

		kill.mockRestore()
	})

	it('signals the process GROUP, not the direct pid', () => {
		// The negative pid is the whole point: `child.kill()` and `spawn`'s own
		// `signal` option both reap the wrapping shell and leave the command
		// running past a cancel.
		if (process.platform === 'win32') return
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

		killTree(child(4242), 'SIGTERM')

		expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')

		kill.mockRestore()
	})
})

describe('a group that is already gone is not an error', () => {
	it('swallows the throw rather than aborting its caller', () => {
		// The caller is a teardown loop over a run's jobs. One job that exited
		// on its own between the list and the signal must not strand every
		// live sibling behind an ESRCH.
		if (process.platform === 'win32') return
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
			const err = new Error('kill ESRCH') as NodeJS.ErrnoException
			err.code = 'ESRCH'
			throw err
		})

		expect(() => killTree(child(4242), 'SIGKILL')).not.toThrow()

		kill.mockRestore()
	})
})
