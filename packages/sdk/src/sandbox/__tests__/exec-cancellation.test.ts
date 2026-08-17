import { describe, expect, it } from 'vitest'

import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { LocalSandboxProvider } from '../provider/local.js'

/**
 * `SandboxExecOptions.signal` was declared, documented, exported — and
 * dropped by every backend. The local one built a fresh `AbortController`
 * from the call's own timeout and never linked the caller's signal to it, so
 * cancelling a run abandoned the *wait* while the sandboxed process kept
 * running. That is verbatim the failure the option's docstring says it exists
 * to prevent.
 *
 * These drive the real provider rather than a stub, because the defect was
 * precisely in the wiring between the option and `spawn` — a stub asserting
 * "the signal was passed along" would have passed against the broken code.
 */
describe('a sandboxed command honours the caller cancellation', () => {
	it('kills a long-running process when the caller aborts', async () => {
		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		const sandbox = await provider.create()
		const controller = new AbortController()

		// Long enough that only the abort can end it: the deadline is 60s and
		// the sleep is 30s, so a pass cannot come from either firing.
		const running = sandbox.exec('node', ['-e', 'setTimeout(() => {}, 30000)'], {
			timeout: 60_000,
			signal: controller.signal,
		})
		setTimeout(() => controller.abort(), 50)

		const result = await running

		expect(result.exitCode).not.toBe(0)
		// Cancelled is not late. Reporting a timeout here would tell the model
		// to retry with a longer budget for something a human just stopped.
		expect(result.timedOut).toBe(false)
		expect(result.durationMs).toBeLessThan(20_000)

		await sandbox.destroy()
	}, 30_000)

	it('still reports a deadline as a timeout when no caller signal is passed', async () => {
		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		const sandbox = await provider.create()

		const result = await sandbox.exec('node', ['-e', 'setTimeout(() => {}, 30000)'], {
			timeout: 300,
		})

		expect(result.timedOut).toBe(true)

		await sandbox.destroy()
	}, 30_000)

	it('leaves an uncancelled command alone', async () => {
		const provider = new LocalSandboxProvider(NOOP_LOGGER)
		const sandbox = await provider.create()
		const controller = new AbortController()

		const result = await sandbox.exec('node', ['-e', 'console.log("done")'], {
			timeout: 30_000,
			signal: controller.signal,
		})

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('done')
		expect(result.timedOut).toBe(false)

		await sandbox.destroy()
	}, 30_000)
})
