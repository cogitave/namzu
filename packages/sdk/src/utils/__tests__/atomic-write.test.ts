import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { atomicWriteFile, temporaryPathFor } from '../atomic-write.js'

/**
 * The rename is what makes the write atomic — a reader sees the old file or
 * the new one, never a half-written one. The sidecar it renames FROM has to
 * be private to this write, and in seven places it was a fixed
 * `${path}.tmp`.
 *
 * Two writers of the same record then shared one scratch file: both opened
 * it, both wrote into it, and the first rename published whatever mixture
 * had landed while the second renamed a file that was no longer there. That
 * is the failure atomic writes exist to prevent, reached through the
 * mechanism meant to prevent it.
 *
 * Not hypothetical here: the cross-process park and unpark handoff is a
 * design where two processes legitimately touch the same records, and it is
 * the feature these stores exist to serve.
 */

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-atomic-'))
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe('the sidecar name', () => {
	it('is different every time', () => {
		const names = new Set(Array.from({ length: 1000 }, () => temporaryPathFor('/x/record.json')))
		// A thousand writes in the same millisecond is a batch, not a stress
		// test — a timestamp alone would collide here.
		expect(names.size).toBe(1000)
	})

	it('stays beside the file it will become', () => {
		expect(temporaryPathFor('/x/record.json').startsWith('/x/record.json.')).toBe(true)
		// Same directory, so the rename is within one filesystem and stays
		// atomic rather than degrading to a copy.
		expect(temporaryPathFor('/x/record.json')).toMatch(/\.tmp$/)
	})

	it('carries the process id, so two processes cannot pick the same one', () => {
		expect(temporaryPathFor('/x/record.json')).toContain(`.${process.pid}.`)
	})
})

describe('writing', () => {
	it('publishes the content', async () => {
		const target = join(dir, 'record.json')
		await atomicWriteFile(target, '{"a":1}')
		expect(readFileSync(target, 'utf-8')).toBe('{"a":1}')
	})

	it('leaves no sidecar behind on success', async () => {
		await atomicWriteFile(join(dir, 'record.json'), 'x')
		expect(readdirSync(dir)).toEqual(['record.json'])
	})

	it('leaves no sidecar behind on failure', async () => {
		// A directory that does not exist fails the write, not the rename.
		await expect(atomicWriteFile(join(dir, 'missing', 'record.json'), 'x')).rejects.toThrow()
		// A leftover sidecar looks like a record to anything scanning the
		// directory, and the next attempt would not reuse it anyway.
		expect(readdirSync(dir)).toEqual([])
	})

	it('does not corrupt a record when two writes race', async () => {
		const target = join(dir, 'record.json')
		const first = 'a'.repeat(200_000)
		const second = 'b'.repeat(200_000)

		await Promise.all([atomicWriteFile(target, first), atomicWriteFile(target, second)])

		// One of them won; neither produced a mixture. With a shared sidecar
		// this is exactly where the halves interleave.
		const written = readFileSync(target, 'utf-8')
		expect([first, second]).toContain(written)
		expect(readdirSync(dir)).toEqual(['record.json'])
	})

	it('survives many concurrent writes to the same record', async () => {
		const target = join(dir, 'record.json')
		const bodies = Array.from({ length: 25 }, (_, i) => `${i}`.repeat(50_000))

		await Promise.all(bodies.map((body) => atomicWriteFile(target, body)))

		expect(bodies).toContain(readFileSync(target, 'utf-8'))
		expect(readdirSync(dir)).toEqual(['record.json'])
	})
})

describe('a contended rename', () => {
	it('does not retry a failure that is not contention', async () => {
		// A missing directory is a permanent condition; retrying it would
		// turn a clear failure into a delay and then the same failure.
		const started = Date.now()
		await expect(atomicWriteFile(join(dir, 'nope', 'record.json'), 'x')).rejects.toThrow()
		expect(Date.now() - started).toBeLessThan(50)
	})
})
