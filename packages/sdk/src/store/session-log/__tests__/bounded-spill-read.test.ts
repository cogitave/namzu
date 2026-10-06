import { appendFile, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import * as evidenceIO from '../../evidence/io.js'
import {
	DiskSpillStore,
	InMemorySpillStore,
	SpillIntegrityError,
	type SpillRef,
	type SpillStore,
	sha256Hex,
} from '../spill.js'

const made: string[] = []
afterAll(async () => await removeTempDirs(made.splice(0)))
afterEach(() => vi.restoreAllMocks())

async function scratch(): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), 'namzu-bounded-spill-')))
	made.push(path)
	return path
}

async function store(kind: 'disk' | 'memory'): Promise<SpillStore> {
	return kind === 'disk' ? new DiskSpillStore(await scratch()) : new InMemorySpillStore()
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe.each(['disk', 'memory'] as const)('%s bounded spill reads', (kind) => {
	it('counts UTF-8 bytes, accepts the exact bound and preserves reads without options', async () => {
		const spills = await store(kind)
		const text = 'hello 🦉 café'
		const ref = await spills.write('unicode', 'text', text)
		expect(ref.bytes).toBe(Buffer.byteLength(text, 'utf8'))
		expect(ref.bytes).toBeGreaterThan(text.length)
		expect(await spills.read(ref)).toBe(text)
		expect(await spills.read(ref, { maxBytes: ref.bytes })).toBe(text)
		await expect(spills.read(ref, { maxBytes: ref.bytes - 1 })).rejects.toThrow(/read limit/)
	})

	it('allows an empty body at a zero-byte bound and refuses a nonempty one', async () => {
		const spills = await store(kind)
		const empty = await spills.write('empty', 'text', '')
		expect(await spills.read(empty, { maxBytes: 0 })).toBe('')
		const body = await spills.write('body', 'text', 'x')
		await expect(spills.read(body, { maxBytes: 0 })).rejects.toThrow(/read limit/)
	})

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		'refuses invalid maxBytes %s before opening the spill',
		async (maxBytes) => {
			const spills = await store(kind)
			const ref = await spills.write('bound', 'text', 'x')
			const open = vi.spyOn(evidenceIO, 'openEvidence')
			await expect(spills.read(ref, { maxBytes })).rejects.toBeInstanceOf(RangeError)
			expect(open).not.toHaveBeenCalled()
		},
	)

	it('refuses invalid declared sizes and a declaration above its bound before opening', async () => {
		const spills = await store(kind)
		const ref = await spills.write('declared', 'text', 'x')
		const open = vi.spyOn(evidenceIO, 'openEvidence')
		for (const bytes of [
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			await expect(spills.read({ ...ref, bytes }, { maxBytes: 8 })).rejects.toBeInstanceOf(
				SpillIntegrityError,
			)
		}
		await expect(spills.read({ ...ref, bytes: 9 }, { maxBytes: 8 })).rejects.toThrow(/read limit/)
		expect(open).not.toHaveBeenCalled()
	})

	it('still refuses missing, wrong-hash and traversal references', async () => {
		const spills = await store(kind)
		const ref = await spills.write('integrity', 'text', 'original')
		await expect(
			spills.read({ ...ref, path: 'tool-results/missing.txt' }, { maxBytes: 64 }),
		).rejects.toBeInstanceOf(SpillIntegrityError)
		await expect(
			spills.read({ ...ref, sha256: sha256Hex('wrong') }, { maxBytes: 64 }),
		).rejects.toThrow(/SHA-256/)
		for (const path of ['../outside.txt', 'tool-results/../../outside.txt', '/outside.txt']) {
			await expect(spills.read({ ...ref, path }, { maxBytes: 64 })).rejects.toBeInstanceOf(
				SpillIntegrityError,
			)
		}
	})

	it.each([false, true])('preserves the exact abort reason (with bound: %s)', async (bounded) => {
		const spills = await store(kind)
		const ref = await spills.write('aborted', 'text', 'x')
		const reason = new Error('the caller cancelled its read')
		const open = vi.spyOn(evidenceIO, 'openEvidence')
		await expect(
			spills.read(ref, {
				...(bounded ? { maxBytes: 1 } : {}),
				signal: AbortSignal.abort(reason),
			}),
		).rejects.toBe(reason)
		expect(open).not.toHaveBeenCalled()
	})
})

describe('bounded disk I/O and file admission', () => {
	it('rejects an oversized actual file with a tiny claimed size without reading or allocating its body', async () => {
		const dir = await scratch()
		const spills = new DiskSpillStore(dir)
		const ref = await spills.write('oversized', 'text', 'x')
		await writeFile(join(dir, ref.path), Buffer.alloc(256 * 1024, 0x61))
		const read = vi.spyOn(evidenceIO, 'readBytes')
		await expect(spills.read(ref, { maxBytes: 4 })).rejects.toThrow(/read limit/)
		expect(read).not.toHaveBeenCalled()
	})

	it('checks an actual size mismatch before reading even when the file is below the limit', async () => {
		const dir = await scratch()
		const spills = new DiskSpillStore(dir)
		const ref = await spills.write('shortened', 'text', 'original')
		await writeFile(join(dir, ref.path), 'short')
		const read = vi.spyOn(evidenceIO, 'readBytes')
		await expect(spills.read(ref, { maxBytes: 64 })).rejects.toThrow(/record says/)
		expect(read).not.toHaveBeenCalled()
	})

	it('rejects a directory before any body read', async () => {
		const dir = await scratch()
		const spills = new DiskSpillStore(dir)
		await mkdir(join(dir, 'tool-results', 'directory'), { recursive: true })
		const ref: SpillRef = {
			path: 'tool-results/directory',
			manifest: 'unused',
			bytes: 0,
			sha256: sha256Hex(''),
		}
		const read = vi.spyOn(evidenceIO, 'readBytes')
		await expect(spills.read(ref, { maxBytes: 0 })).rejects.toMatchObject({
			name: 'SpillIntegrityError',
			cause: expect.objectContaining({ message: expect.stringMatching(/regular file/) }),
		})
		expect(read).not.toHaveBeenCalled()
	})

	it('refuses a file symlink escape for bounded reads while preserving the legacy reader', async () => {
		const dir = await scratch()
		const outside = await scratch()
		const spills = new DiskSpillStore(dir)
		await mkdir(join(dir, 'tool-results'))
		await writeFile(join(outside, 'body.txt'), 'same')
		await symlink(join(outside, 'body.txt'), join(dir, 'tool-results', 'link.txt'), 'file')
		const ref: SpillRef = {
			path: 'tool-results/link.txt',
			manifest: 'unused',
			bytes: 4,
			sha256: sha256Hex('same'),
		}
		expect(await spills.read(ref)).toBe('same')
		await expect(spills.read(ref, { maxBytes: 4 })).rejects.toMatchObject({
			name: 'SpillIntegrityError',
			cause: expect.objectContaining({ message: expect.stringMatching(/symlinks/) }),
		})
	})

	it('refuses an intermediate directory symlink escape', async () => {
		const dir = await scratch()
		const outside = await scratch()
		const spills = new DiskSpillStore(dir)
		await mkdir(join(dir, 'tool-results'))
		await writeFile(join(outside, 'body.txt'), 'same')
		await symlink(outside, join(dir, 'tool-results', 'jump'), 'junction')
		const ref: SpillRef = {
			path: 'tool-results/jump/body.txt',
			manifest: 'unused',
			bytes: 4,
			sha256: sha256Hex('same'),
		}
		await expect(spills.read(ref, { maxBytes: 4 })).rejects.toMatchObject({
			name: 'SpillIntegrityError',
			cause: expect.objectContaining({ message: expect.stringMatching(/symlinks/) }),
		})
	})

	it('rejects invalid UTF-8 even when the raw bytes match their declared length and hash', async () => {
		const dir = await scratch()
		const spills = new DiskSpillStore(dir)
		const ref = await spills.write('utf8', 'text', 'ok')
		const bytes = Buffer.from([0xc3, 0x28])
		await writeFile(join(dir, ref.path), bytes)
		await expect(
			spills.read({ ...ref, bytes: bytes.length, sha256: sha256Hex(bytes) }, { maxBytes: 2 }),
		).rejects.toMatchObject({ name: 'SpillIntegrityError', cause: expect.any(TypeError) })
	})

	it('refuses a file changed between body reading and the final stat', async () => {
		const dir = await scratch()
		const spills = new DiskSpillStore(dir)
		const ref = await spills.write('changed', 'text', 'original')
		const readBytes = evidenceIO.readBytes
		vi.spyOn(evidenceIO, 'readBytes').mockImplementation(async (...args) => {
			const bytes = await readBytes(...args)
			await appendFile(join(dir, ref.path), '!')
			return bytes
		})
		await expect(spills.read(ref, { maxBytes: 64 })).rejects.toThrow(/changed while reading/)
	})

	it('cancels an in-flight chunk with no next read and closes its handle', async () => {
		const dir = await scratch()
		const spills = new DiskSpillStore(dir)
		const ref = await spills.write('chunks', 'text', 'x'.repeat(200_000))
		const entered = deferred()
		const release = deferred()
		const controller = new AbortController()
		const reason = new Error('stop after entering a chunk')
		const openEvidence = evidenceIO.openEvidence
		const reads: number[] = []
		let close: ReturnType<typeof vi.fn> | undefined
		vi.spyOn(evidenceIO, 'openEvidence').mockImplementation(async (path) => {
			const handle = await openEvidence(path)
			const read = handle.read.bind(handle) as (
				buffer: Buffer,
				offset: number,
				length: number,
				position: number,
			) => Promise<{ bytesRead: number; buffer: Buffer }>
			vi.spyOn(handle, 'read').mockImplementation((async (
				buffer: Buffer,
				offset: number,
				length: number,
				position: number,
			) => {
				reads.push(length)
				entered.resolve()
				await release.promise
				return read(buffer, offset, length, position)
			}) as typeof handle.read)
			close = vi.spyOn(handle, 'close')
			return handle
		})
		const pending = spills.read(ref, { maxBytes: ref.bytes, signal: controller.signal })
		await entered.promise
		controller.abort(reason)
		release.resolve()
		await expect(pending).rejects.toBe(reason)
		expect(reads).toEqual([65_536])
		expect(close).toHaveBeenCalledOnce()
	})

	it('does not publish decoded text when cancellation happens at the last boundary', async () => {
		const dir = await scratch()
		const spills = new DiskSpillStore(dir)
		const ref = await spills.write('last-boundary', 'text', 'ready')
		const controller = new AbortController()
		const reason = new Error('stop before returning the text')
		const decode = evidenceIO.decode
		vi.spyOn(evidenceIO, 'decode').mockImplementation((bytes) => {
			const text = decode(bytes)
			controller.abort(reason)
			return text
		})
		await expect(spills.read(ref, { maxBytes: ref.bytes, signal: controller.signal })).rejects.toBe(
			reason,
		)
	})
})
