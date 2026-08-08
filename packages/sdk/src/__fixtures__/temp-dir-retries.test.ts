/**
 * The retry options reach both calls.
 *
 * `fs.rmSync` and `fsPromises.rm` default `maxRetries` to **0**, so every bare
 * call site in this package had no retry at all for exactly the errors the API
 * documents (`EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`, `EPERM`). Asking for
 * retries is the substance of these helpers, and the behavioural tests beside
 * this one would all still pass if a future edit quietly dropped the options
 * back to the default — the tree would still be removed, and nothing would be
 * retried.
 *
 * Its own file because it mocks `node:fs` and `node:fs/promises`, which the
 * behavioural tests need to be real. Both are asserted: an edit that keeps the
 * options on the sync path and loses them on the async one would be the
 * some-sites failure this repository has a convention about, on a helper whose
 * async form carries 46 of the 59 call sites.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const rmSync = vi.fn()
// No implementation, deliberately: an implementation would give the spy a
// concrete signature, and the mock factory below spreads its arguments.
// `await undefined` is what the helper does with the result either way.
const rm = vi.fn()
vi.mock('node:fs', () => ({ rmSync: (...args: unknown[]) => rmSync(...args) }))
vi.mock('node:fs/promises', () => ({ rm: (...args: unknown[]) => rm(...args) }))

afterEach(() => {
	rmSync.mockReset()
	rm.mockReset()
})

/** The two options that matter. Without them this is the bare call that let a
 * cleanup race fail a passing test. */
const RETRIES = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }

describe('the cleanup helpers ask for retries, which the default does not', () => {
	it('removeTempDir does', async () => {
		const { removeTempDir } = await import('./temp-dir.js')

		removeTempDir('/some/path')

		expect(rmSync).toHaveBeenCalledTimes(1)
		expect(rmSync).toHaveBeenCalledWith('/some/path', expect.objectContaining(RETRIES))
	})

	it('removeTempDirAsync does', async () => {
		const { removeTempDirAsync } = await import('./temp-dir.js')

		await removeTempDirAsync('/some/path')

		expect(rm).toHaveBeenCalledTimes(1)
		expect(rm).toHaveBeenCalledWith('/some/path', expect.objectContaining(RETRIES))
	})

	it('removeTempDirs does, once per path', async () => {
		const { removeTempDirs } = await import('./temp-dir.js')

		await removeTempDirs(['/a', '/b'])

		expect(rm).toHaveBeenCalledTimes(2)
		expect(rm).toHaveBeenNthCalledWith(1, '/a', expect.objectContaining(RETRIES))
		expect(rm).toHaveBeenNthCalledWith(2, '/b', expect.objectContaining(RETRIES))
	})
})
