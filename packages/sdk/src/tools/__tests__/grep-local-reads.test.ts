import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { walkFilesLocally } from '../../sandbox/file-walk.js'
import type { ToolContext } from '../../types/tool/index.js'
import { CAN_REFUSE_LINKS, readBoundedFileSync } from '../builtins/bounded-file-read.js'
import { GrepTool } from '../builtins/grep.js'
import { readAhead } from '../builtins/search-support.js'

// What the local search costs is counted in file-system calls, never in time.
const calls = vi.hoisted(() => ({
	realpath: 0,
	lstat: 0,
	open: 0,
	openSync: 0,
	closeSync: 0,
}))
vi.mock('node:fs/promises', async (original) => {
	const fs = await original<typeof import('node:fs/promises')>()
	return {
		...fs,
		realpath: (...args: Parameters<typeof fs.realpath>) => {
			calls.realpath++
			return fs.realpath(...args)
		},
		lstat: (...args: Parameters<typeof fs.lstat>) => {
			calls.lstat++
			return fs.lstat(...args)
		},
		open: (...args: Parameters<typeof fs.open>) => {
			calls.open++
			return fs.open(...args)
		},
	}
})
vi.mock('node:fs', async (original) => {
	const fs = await original<typeof import('node:fs')>()
	return {
		...fs,
		openSync: (...args: Parameters<typeof fs.openSync>) => {
			calls.openSync++
			return fs.openSync(...args)
		},
		closeSync: (...args: Parameters<typeof fs.closeSync>) => {
			calls.closeSync++
			return fs.closeSync(...args)
		},
	}
})

const temporary: string[] = []
beforeEach(() => {
	for (const key of Object.keys(calls)) calls[key as keyof typeof calls] = 0
})
afterEach(() => {
	for (const path of temporary.splice(0)) removeTempDir(path)
})

function tree(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-grep-reads-')))
	temporary.push(root)
	return root
}
function fill(root: string, count: number, hit = (i: number) => i % 3 === 0) {
	mkdirSync(join(root, 'src'), { recursive: true })
	for (let i = 0; i < count; i++) {
		writeFileSync(
			join(root, 'src', `f${String(i).padStart(4, '0')}.txt`),
			hit(i) ? 'needle\n' : 'hay\n',
		)
	}
}
const ctx = (root: string, extra: Partial<ToolContext> = {}) =>
	({
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2',
		workingDirectory: root,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...extra,
	}) as ToolContext
const grep = (root: string, input: object, extra: Partial<ToolContext> = {}) =>
	GrepTool.execute(GrepTool.inputSchema.parse({ pattern: 'needle', ...input }), ctx(root, extra))

describe('grep reads local files through one handle each', () => {
	it.skipIf(!CAN_REFUSE_LINKS)(
		'resolves real paths per directory, not per file, and opens each file once',
		async () => {
			const small = tree()
			fill(small, 20)
			await grep(small, { output_mode: 'count', head_limit: 0 })
			const few = { ...calls }
			for (const key of Object.keys(calls)) calls[key as keyof typeof calls] = 0

			const large = tree()
			fill(large, 80)
			await grep(large, { output_mode: 'count', head_limit: 0 })
			const many = { ...calls }

			// One directory in both trees: the path resolutions do not grow with files.
			expect(many.realpath).toBe(few.realpath)
			// Matched files are stat'ed once each to order them; counting mode matches
			// three in twenty and three in eighty alike, so only that term may grow.
			expect(many.lstat).toBe(few.lstat)
			expect(many.open).toBe(0)
			// One synchronous open and close per file, nothing more.
			expect(few.openSync).toBe(20)
			expect(many.openSync).toBe(80)
			expect(many.closeSync).toBe(many.openSync)
		},
	)

	it('finds the same files in the same order as before in files mode', async () => {
		const root = tree()
		fill(root, 12)
		const result = await grep(root, { head_limit: 0 })
		expect(result.success).toBe(true)
		const listed = String(result.output).split('\n').slice(1, 5)
		expect(listed.every((line) => line.startsWith('src/f'))).toBe(true)
		expect(result.data).toMatchObject({ filesMatched: 4, filesSearched: 12 })
	})

	it('does not read a symlink to a file outside the root, nor descend a linked directory', async () => {
		const root = tree()
		const outside = tree()
		fill(root, 2, () => false)
		writeFileSync(join(outside, 'secret.txt'), 'needle outside\n')
		symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
		symlinkSync(outside, join(root, 'linked'))
		const result = await grep(root, { output_mode: 'content', head_limit: 0 })
		expect(String(result.output)).not.toContain('outside')
		expect(result.data).toMatchObject({ filesMatched: 0 })
	})

	it.skipIf(!CAN_REFUSE_LINKS)(
		'refuses a link swapped in for a file after the walk listed it',
		() => {
			const root = tree()
			const outside = tree()
			writeFileSync(join(outside, 'secret.txt'), 'needle outside\n')
			symlinkSync(join(outside, 'secret.txt'), join(root, 'swapped.txt'))
			expect(() => readBoundedFileSync(join(root, 'swapped.txt'), 1024)).toThrow(/ELOOP|symbolic/i)
		},
	)

	it.skipIf(!CAN_REFUSE_LINKS)(
		'answers too-large from the handle, and refuses a non-regular file',
		() => {
			const root = tree()
			writeFileSync(join(root, 'big.txt'), 'x'.repeat(2048))
			writeFileSync(join(root, 'fits.txt'), 'x'.repeat(1024))
			expect(readBoundedFileSync(join(root, 'big.txt'), 1024)).toBe('too-large')
			expect((readBoundedFileSync(join(root, 'fits.txt'), 1024) as Buffer).length).toBe(1024)
			expect(() => readBoundedFileSync(root, 1024)).toThrow()
		},
	)

	it('skips a file over the cap without calling it unreadable, and counts an unreadable one', async () => {
		const root = tree()
		writeFileSync(join(root, 'huge.txt'), `needle${'x'.repeat(5 * 1024 * 1024)}`)
		writeFileSync(join(root, 'bin.dat'), Buffer.from('needle\0binary'))
		writeFileSync(join(root, 'ok.txt'), 'needle\n')
		writeFileSync(join(root, 'locked.txt'), 'needle\n')
		chmodSync(join(root, 'locked.txt'), 0)
		try {
			const result = await grep(root, { output_mode: 'count', head_limit: 0 })
			expect(String(result.output)).toContain('ok.txt:1')
			expect(String(result.output)).not.toContain('huge.txt')
			expect(String(result.output)).not.toContain('bin.dat')
			// Running as a user that can read a mode-0 file is not an unreadable file.
			if (!String(result.output).includes('locked.txt')) {
				expect(String(result.output)).toContain('1 file could not be read')
			}
		} finally {
			chmodSync(join(root, 'locked.txt'), 0o644)
		}
	})

	it('treats a file deleted after it was listed as absent', async () => {
		const root = tree()
		for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(root, name), 'needle\n')
		let deleted = false
		const result = await grep(
			root,
			{ output_mode: 'count', head_limit: 0 },
			{
				readDenied: (path) => {
					if (path.endsWith('a.txt') && !deleted) {
						deleted = true
						unlinkSync(join(root, 'c.txt'))
					}
					return false
				},
			},
		)
		expect(result.success).toBe(true)
		expect(String(result.output)).toContain('2 files searched')
		expect(String(result.output)).not.toContain('could not be read')
	})

	it('stops when the signal aborts and keeps what it already read', async () => {
		const root = tree()
		fill(root, 30, () => true)
		const controller = new AbortController()
		let seen = 0
		const result = await grep(
			root,
			{ output_mode: 'count', head_limit: 0 },
			{
				abortSignal: controller.signal,
				readDenied: () => {
					if (++seen === 5) controller.abort(new Error('stop'))
					return false
				},
			},
		)
		// The files read before the abort are reported; the rest are not read.
		expect(seen).toBeLessThan(30)
		expect(result.data).toMatchObject({ filesMatched: 4 })
	})
})

describe('the walk without sizes', () => {
	it('lists the same files as the default walk, with no size read per file', async () => {
		const root = tree()
		fill(root, 10)
		const run = async (withoutSizes: boolean) => {
			const paths: string[] = []
			const before = calls.lstat
			for await (const entry of walkFilesLocally(root, {
				pattern: '**/*',
				maxEntries: 100,
				...(withoutSizes ? { withoutSizes: true } : {}),
			}))
				paths.push(entry.path)
			return { paths, lstat: calls.lstat - before }
		}
		const plain = await run(false)
		const bare = await run(true)
		expect(bare.paths).toEqual(plain.paths)
		expect(plain.lstat).toBeGreaterThanOrEqual(10)
		expect(bare.lstat).toBeLessThan(plain.lstat)
	})
})

describe('readAhead', () => {
	async function* numbers(count: number, onClose?: () => void) {
		try {
			for (let i = 0; i < count; i++) yield i
		} finally {
			onClose?.()
		}
	}
	it('keeps order and ends with the source', async () => {
		const out: number[] = []
		for await (const n of readAhead(numbers(1000), 8)) out.push(n)
		expect(out).toEqual(Array.from({ length: 1000 }, (_, i) => i))
	})
	it('closes the source when the consumer stops early', async () => {
		const onClose = vi.fn()
		for await (const n of readAhead(numbers(1000, onClose), 8)) if (n === 3) break
		expect(onClose).toHaveBeenCalledOnce()
	})
	it('delivers what came before a failure, then the failure', async () => {
		async function* failing() {
			yield 1
			yield 2
			throw new Error('walk failed')
		}
		const out: number[] = []
		await expect(
			(async () => {
				for await (const n of readAhead(failing(), 8)) out.push(n)
			})(),
		).rejects.toThrow('walk failed')
		expect(out).toEqual([1, 2])
	})
	it('reads no further ahead than asked while the consumer is paused', async () => {
		let pulled = 0
		async function* counted() {
			for (let i = 0; i < 100; i++) {
				pulled++
				yield i
			}
		}
		const iterator = readAhead(counted(), 4)
		await iterator.next()
		// A paused consumer lets the producer fill its buffer and no more.
		await new Promise<void>((done) => setImmediate(done))
		expect(pulled).toBeLessThanOrEqual(4 + 2)
		await iterator.return(undefined)
	})
})
