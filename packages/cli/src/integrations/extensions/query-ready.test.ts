import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { waitForEndpoint } from './query.js'

describe.skipIf(process.platform === 'win32')('waitForEndpoint', () => {
	it('resolves true once a server starts listening after the wait began', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'ext-ready-'))
		const addr = join(dir, 'q.sock')
		const server = createServer((s) => s.end())
		try {
			const up = waitForEndpoint(addr)
			// Nothing listens yet: the wait is pending, and it ends when the socket opens, not on a clock.
			await new Promise<void>((resolve) => server.listen(addr, resolve))
			await expect(up).resolves.toBe(true)
		} finally {
			server.close()
			removeTempDir(dir)
		}
	})

	it('resolves false at once when its signal aborts, and for a signal already aborted', async () => {
		vi.useFakeTimers()
		try {
			const addr = join(tmpdir(), 'ext-ready-abort', 'q.sock')
			const c = new AbortController()
			const up = waitForEndpoint(addr, 60_000, c.signal)
			c.abort()
			await expect(up).resolves.toBe(false)
			await expect(waitForEndpoint(addr, 60_000, c.signal)).resolves.toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it('resolves false when nothing ever listens before the deadline', async () => {
		vi.useFakeTimers()
		try {
			const dir = join(tmpdir(), 'ext-ready-never', 'q.sock')
			const up = waitForEndpoint(dir, 1_000)
			await vi.advanceTimersByTimeAsync(1_000)
			await expect(up).resolves.toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})
})
