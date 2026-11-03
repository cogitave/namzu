import { describe, expect, it, vi } from 'vitest'

import { stopAtHostExit, trackedForHostExit } from '../host-exit-finalizer.js'

/**
 * `kill(-1)` signals every process of the user and `kill(0)` the caller's own
 * group. The host-exit sweep handed a tracked job's pid to `kill(-pid)`, so a
 * job recorded with a placeholder pid took the runner down with it. The sweep
 * must treat such a pid as already gone.
 */
describe('the host-exit sweep', () => {
	it('never signals pid 0, 1, a negative, a fractional or a NaN pid', () => {
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
		const untrack = [0, 1, -1, Number.NaN, 1.5].map((pid) => stopAtHostExit({ child: { pid } }))
		try {
			const sweep = process.listeners('exit').find((l) => l.name === 'finalizeAtHostExit')
			expect(sweep).toBeDefined()
			expect(() => (sweep as () => void)()).not.toThrow()
			expect(kill).not.toHaveBeenCalled()
			expect(trackedForHostExit()).toBe(0)
		} finally {
			for (const done of untrack) done()
			kill.mockRestore()
		}
	})
})
