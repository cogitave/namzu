/**
 * The retry option reaches the call.
 *
 * `fs.rmSync` defaults `maxRetries` to **0**, so every bare call site in this
 * package had no retry at all for exactly the errors the API documents
 * (`EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`, `EPERM`). Asking for retries is
 * the substance of the helper, and the behavioural tests beside this one would
 * all still pass if a future edit quietly dropped the option back to the
 * default — the tree would still be removed, and nothing would be retried.
 *
 * Its own file because it mocks `node:fs`, which the behavioural tests need to
 * be real.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const rmSync = vi.fn()
vi.mock('node:fs', () => ({ rmSync: (...args: unknown[]) => rmSync(...args) }))

afterEach(() => {
	rmSync.mockReset()
})

describe('removeTempDir', () => {
	it('asks for retries, which the default does not', async () => {
		const { removeTempDir } = await import('./temp-dir.js')

		removeTempDir('/some/path')

		expect(rmSync).toHaveBeenCalledTimes(1)
		expect(rmSync).toHaveBeenCalledWith(
			'/some/path',
			expect.objectContaining({
				recursive: true,
				force: true,
				// The two that matter. Without them this is the bare call that let a
				// cleanup race fail a passing test.
				maxRetries: 10,
				retryDelay: 50,
			}),
		)
	})
})
