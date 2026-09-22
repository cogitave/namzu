import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { drainParkedTurns } from '../drain.js'
import { queue } from './support/queue.js'

/**
 * `drain.ts` claims, in prose: "A supervisor, a daemon, or a scheduler.
 * There is no timer here, no process spawn, no retry backoff and no
 * `while (true)`."
 *
 * That claim has been cited as the kernel's position on a whole
 * capability, so it had better be true, and until this file nothing
 * checked it. A paragraph is not a check
 * ("a falsifiable comment is a test"): a later change
 * that added one `setTimeout` for a retry would leave the sentence
 * standing and reading as authoritative.
 *
 * Two halves, both mechanical. No timer is armed during a full pass, and
 * nothing reachable from this module can spawn a process.
 */

describe('drainParkedTurns makes one pass and arms nothing', () => {
	it('never schedules a timer across a full pass over several turns', async () => {
		// Several turns, so a per-turn backoff would be caught as surely as a
		// per-pass one. Spied rather than faked: `vi.useFakeTimers` would
		// make an armed timer simply not fire, which is the opposite of what
		// is being asserted — the claim is that none is ARMED.
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

		try {
			const q = await queue([{ parked: true }, { parked: true }, { parked: true }])

			const result = await drainParkedTurns({
				...q.base,
				holder: 'worker-1',
				ttlMs: 60_000,
				onTurn: async () => {},
			})

			// The pass must actually have done something, or a `drainParkedTurns`
			// that returned early would satisfy the timer assertions for the
			// wrong reason.
			expect(result.listed, 'the pass listed nothing, so it proved nothing').toBeGreaterThan(0)
			expect(result.drained.length + result.skipped.length).toBeGreaterThan(0)
			expect(setTimeoutSpy, 'drainParkedTurns armed a timer').not.toHaveBeenCalled()
			expect(setIntervalSpy, 'drainParkedTurns armed an interval').not.toHaveBeenCalled()
		} finally {
			setTimeoutSpy.mockRestore()
			setIntervalSpy.mockRestore()
		}
	})

	it('imports nothing that can spawn a process', () => {
		// The "no process spawn" half. Read from source rather than asserted
		// against behaviour, because a spawn on a path this test does not
		// take would still make the sentence false.
		const raw = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), '..', 'drain.ts'),
			'utf8',
		)
		// Comments stripped first. The module's own prose SAYS `while (true)`
		// and `scheduler` in the course of ruling them out, so a bare
		// substring search over the whole file asserts the opposite of what
		// is meant — it fails precisely because the claim is documented.
		const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

		expect(code, 'drain.ts can spawn a process').not.toContain('child_process')
		expect(code, 'drain.ts has an unbounded loop').not.toContain('while (true)')
		expect(code, 'drain.ts arms an interval').not.toContain('setInterval')
		expect(code, 'drain.ts arms a timer').not.toContain('setTimeout')
	})
})
