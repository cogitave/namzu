import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readBoundedChunks, readBoundedFile } from '../bounded-file-read.js'
import { NOTEBOOK_MAX_OUTPUT_BYTES, readNotebook } from '../read-media.js'

// No wall-clock races: an infinite/growing source is a deterministic range reader.
describe('bounded input reads', () => {
	it('stops a source that grows forever after exactly the ceiling plus one byte', async () => {
		let requested = 0
		const read = vi.fn(async (_offset: number, length: number) => {
			requested += length
			return Buffer.alloc(length, 120)
		})
		await expect(readBoundedChunks(read, 150_000)).rejects.toThrow('bounded read limit')
		expect(requested).toBe(150_001)
		expect(read.mock.calls.map(([, length]) => length)).toEqual([65_536, 65_536, 18_929])
	})

	it('accepts exactly the ceiling, probing at most one byte beyond it', async () => {
		const body = Buffer.from('12345678')
		const read = vi.fn(async (offset: number, length: number) =>
			body.subarray(offset, offset + length),
		)
		expect(await readBoundedChunks(read, 8)).toEqual(body)
		expect(read).toHaveBeenCalledExactlyOnceWith(0, 9)
	})

	it('applies a signature-selected ceiling even if the source keeps growing', async () => {
		let requested = 0
		await expect(
			readBoundedChunks(
				async (_offset, length) => {
					requested += length
					return Buffer.alloc(length)
				},
				200_000,
				undefined,
				() => 70_000,
			),
		).rejects.toThrow('70000 bytes')
		expect(requested).toBe(70_001)
	})

	it('refuses a backend that ignores the requested range', async () => {
		await expect(readBoundedChunks(async () => Buffer.alloc(11), 8)).rejects.toThrow(
			'bounded range',
		)
	})

	it('does not issue IO after cancellation', async () => {
		const read = vi.fn(async () => Buffer.alloc(0))
		const controller = new AbortController()
		controller.abort(new Error('stopped'))
		await expect(readBoundedChunks(read, 8, controller.signal)).rejects.toThrow('stopped')
		expect(read).not.toHaveBeenCalled()
	})

	it('refuses a sparse oversized host file and a directory', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-bounded-'))
		try {
			const path = join(dir, 'huge')
			await writeFile(path, '')
			await truncate(path, 1024 * 1024)
			await expect(readBoundedFile(path, 16)).rejects.toThrow('bounded read limit')
			await expect(readBoundedFile(dir, 16)).rejects.toThrow('regular file')
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe('notebook output admission', () => {
	it('counts UTF-8 bytes, not source character count, against the aggregate output budget', () => {
		const source = '界'.repeat(Math.floor(NOTEBOOK_MAX_OUTPUT_BYTES / 3))
		const result = readNotebook(
			Buffer.from(JSON.stringify({ cells: [{ source, cell_type: 'markdown' }] })),
			'n.ipynb',
		)
		expect(result).toMatchObject({
			ok: false,
			message: expect.stringContaining('1 MiB encoded output budget'),
		})
	})

	it('budgets the total of many individually small cells', () => {
		const cells = Array.from({ length: 200 }, () => ({
			source: 'x'.repeat(6000),
			cell_type: 'markdown',
		}))
		expect(readNotebook(Buffer.from(JSON.stringify({ cells })), 'n.ipynb').ok).toBe(false)
	})
})
