/**
 * `Sandbox.readFile`'s range, on the backend that ships with the SDK.
 *
 * The contract draws a hard line that only a test can hold: a backend which
 * ACCEPTS `offset`/`length` and answers with the whole file has given a wrong
 * answer, not a degraded one — the caller asked for 256 bytes, got a
 * gigabyte, and has no way to tell. Declaring the one-parameter form does not
 * close that: through the `Sandbox` type a caller can still pass options, and
 * TypeScript is happy, so the only honest outcomes are "serve the slice" and
 * "throw".
 *
 * The local provider can serve it — a slice of a file on a local filesystem
 * is one positional read — so these cases assert the bytes rather than a
 * refusal, including the two edges that are easy to get wrong: a range that
 * runs off the end, and a range that starts past it.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { LocalSandboxProvider } from '../provider/local.js'

const workspaces: string[] = []

afterEach(async () => {
	await removeTempDirs(workspaces)
	workspaces.length = 0
})

/** 4 KiB of deterministic bytes, so a misplaced slice cannot pass by luck. */
const PAYLOAD = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 251))

async function sandboxWithPayload() {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-ranged-read-'))
	workspaces.push(cwd)
	await writeFile(join(cwd, 'payload.bin'), PAYLOAD)
	return await new LocalSandboxProvider(NOOP_LOGGER).create({
		workingDirectory: cwd,
	})
}

describe('a ranged readFile on the local provider', () => {
	it('returns exactly the bytes asked for, not the whole file', async () => {
		const sandbox = await sandboxWithPayload()
		try {
			const slice = await sandbox.readFile('payload.bin', {
				offset: 1_000,
				length: 256,
			})
			expect(slice.length).toBe(256)
			expect(slice.toString('base64')).toBe(PAYLOAD.subarray(1_000, 1_256).toString('base64'))
		} finally {
			await sandbox.destroy()
		}
	})

	it('clips a range that runs past the end, and answers nothing past it', async () => {
		const sandbox = await sandboxWithPayload()
		try {
			// A caller resuming from a remembered offset cannot know where the
			// file ends before it asks, so neither of these is an error.
			const straddling = await sandbox.readFile('payload.bin', {
				offset: PAYLOAD.length - 10,
				length: 500,
			})
			expect(straddling.toString('base64')).toBe(PAYLOAD.subarray(-10).toString('base64'))

			const beyond = await sandbox.readFile('payload.bin', {
				offset: PAYLOAD.length + 99,
			})
			expect(beyond.length).toBe(0)
		} finally {
			await sandbox.destroy()
		}
	})

	it('reads to the end when only an offset is given', async () => {
		const sandbox = await sandboxWithPayload()
		try {
			const tail = await sandbox.readFile('payload.bin', { offset: 4_000 })
			expect(tail.toString('base64')).toBe(PAYLOAD.subarray(4_000).toString('base64'))
		} finally {
			await sandbox.destroy()
		}
	})

	it('still answers the whole file when no options are given', async () => {
		const sandbox = await sandboxWithPayload()
		try {
			const whole = await sandbox.readFile('payload.bin')
			expect(whole.toString('base64')).toBe(PAYLOAD.toString('base64'))
		} finally {
			await sandbox.destroy()
		}
	})

	it('refuses an offset or length that is not a non-negative safe integer', async () => {
		const sandbox = await sandboxWithPayload()
		try {
			await expect(sandbox.readFile('payload.bin', { offset: -1 })).rejects.toThrow(/offset/)
			await expect(sandbox.readFile('payload.bin', { length: 1.5 })).rejects.toThrow(/length/)
		} finally {
			await sandbox.destroy()
		}
	})

	// `signal` is documented as aborting the read, and an aborted read that
	// answers with data has not been aborted. A positional read takes no
	// signal of its own, so the provider checks it on both sides of the one
	// it makes — both shapes are pinned here.
	it('answers an aborted signal with the abort, on both shapes', async () => {
		const sandbox = await sandboxWithPayload()
		try {
			const reason = new Error('the caller stopped wanting it')
			await expect(
				sandbox.readFile('payload.bin', {
					offset: 0,
					length: 16,
					signal: AbortSignal.abort(reason),
				}),
			).rejects.toThrow(reason)
			await expect(
				sandbox.readFile('payload.bin', { signal: AbortSignal.abort(reason) }),
			).rejects.toThrow(reason)
		} finally {
			await sandbox.destroy()
		}
	})
})
