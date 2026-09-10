import type { Dir, Dirent } from 'node:fs'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import type {
	SandboxExecOptions,
	SandboxExecResult,
	SandboxFileEntry,
} from '../../types/sandbox/index.js'
import { walkFilesLocally, walkFilesViaExec } from '../file-walk.js'

const io = vi.hoisted(() => ({
	open: vi.fn(),
	original: undefined as unknown as typeof import('node:fs/promises').opendir,
}))
vi.mock('node:fs/promises', async (original) => {
	const fs = await original<typeof import('node:fs/promises')>()
	io.original = fs.opendir
	return { ...fs, opendir: io.open }
})
const dirs: string[] = []
beforeEach(() => {
	io.open.mockReset().mockImplementation(io.original)
})
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-file-walk-')))
	dirs.push(root)
	for (const name of ['src', 'src/deep', 'unrelated', '.config', 'a', 'a/b', 'c'])
		await mkdir(join(root, name), { recursive: true })
	for (const name of [
		'top.ts',
		'.env',
		'.secret.ts',
		'src/one.ts',
		'src/.secret.ts',
		'src/two.js',
		'src/deep/three.ts',
		'unrelated/other.ts',
		'.config/value.json',
		'.config/.secret.ts',
		'a/b/x',
		'c/x',
	])
		await writeFile(join(root, name), 'x')
	return root
}
async function collect(source: AsyncIterable<SandboxFileEntry>) {
	const result: SandboxFileEntry[] = []
	for await (const entry of source) result.push(entry)
	return result
}
const complete: SandboxExecResult = {
	exitCode: 0,
	stdout: '',
	stderr: '',
	timedOut: false,
	durationMs: 1,
}
const line = (path: string) => `${JSON.stringify({ type: 'entry', path, size: 1 })}\n`

it('local and guest walkers search only a named regular file and honor include filters', async () => {
	const root = await fixture()
	const file = join(root, 'top.ts')
	const exec = async (_command: string, argv: string[] = []): Promise<SandboxExecResult> => {
		let stdout = ''
		const guest = {
			argv: ['node', argv[2]],
			exitCode: 0,
			stdout: {
				write: (text: string) => {
					stdout += text
					return true
				},
			},
		}
		await runInNewContext(argv[1] ?? '', {
			require: createRequire(import.meta.url),
			process: guest,
		})
		return { ...complete, stdout, exitCode: guest.exitCode }
	}
	for (const pattern of ['**/*', '*.ts', '*.json']) {
		const options = { pattern, maxEntries: 1 }
		const expected = pattern === '*.json' ? [] : [{ path: file, size: 1 }]
		expect(await collect(walkFilesLocally(file, options))).toEqual(expected)
		expect(await collect(walkFilesViaExec(exec, file, options))).toEqual(expected)
	}
	expect(io.open).not.toHaveBeenCalled()
})

describe('bounded local file enumeration', () => {
	it.each(['*', '*.ts', '**.ts', '{*.ts,*.js}', '@(top|skip).ts'])(
		'does not open any descendant for single-segment %s',
		async (pattern) => {
			const root = await fixture()
			const entries = await collect(walkFilesLocally(root, { pattern, maxEntries: 20 }))
			expect(entries.map((entry) => entry.path)).toEqual([join(root, 'top.ts')])
			expect(io.open.mock.calls.map(([path]) => path)).toEqual([root])
		},
	)
	it('keeps actual globstars recursive and matches extglobs per path component', async () => {
		const root = await fixture()
		await mkdir(join(root, 'a/b/a/b'), { recursive: true })
		await writeFile(join(root, 'a/b/a/b/x'), 'x')
		const globstar = await collect(walkFilesLocally(root, { pattern: '**', maxEntries: 30 }))
		expect(globstar.some((entry) => entry.path === join(root, 'src/deep/three.ts'))).toBe(true)
		const repeated = await collect(walkFilesLocally(root, { pattern: '+(a/b/)x', maxEntries: 30 }))
		expect(repeated).toEqual([])
		const component = await collect(
			walkFilesLocally(root, { pattern: 'src/@(one|two).*', maxEntries: 30 }),
		)
		expect(component.map((entry) => entry.path).sort()).toEqual([
			join(root, 'src/one.ts'),
			join(root, 'src/two.js'),
		])
	})
	it.each([
		['!(skip)', ['top.ts']],
		['{*.ts,*.js}', ['top.ts']],
		['@(*.ts|*.js)', ['top.ts']],
		['[^a]env', []],
		['{.env,*}', ['.env', 'top.ts']],
		['{,foo}*.ts', ['top.ts']],
		['[.]env', ['.env']],
		['[.]config/*.json', ['.config/value.json']],
		['@(.config|src)/*.json', ['.config/value.json']],
	] as const)(
		'excludes implicit hidden matches while preserving explicit dots in %s',
		async (pattern, expected) => {
			const root = await fixture()
			const entries = await collect(walkFilesLocally(root, { pattern, maxEntries: 30 }))
			expect(entries.map((entry) => entry.path).sort()).toEqual(
				expected.map((name) => join(root, name)).sort(),
			)
		},
	)
	it('allows grouped hidden matches only when requested and prunes hidden directories otherwise', async () => {
		const root = await fixture()
		const hidden = await collect(
			walkFilesLocally(root, { pattern: '**/{*.ts,*.js}', includeHidden: true, maxEntries: 30 }),
		)
		expect(hidden.map((entry) => entry.path)).toContain(join(root, '.config/.secret.ts'))
		io.open.mockClear()
		const ordinary = await collect(
			walkFilesLocally(root, { pattern: '**/{*.ts,*.js}', maxEntries: 30 }),
		)
		expect(ordinary.some((entry) => entry.path.includes('/.'))).toBe(false)
		expect(io.open.mock.calls.map(([path]) => path)).not.toContain(join(root, '.config'))
	})
	it('refuses excessive brace expansion and source length before filesystem or provider IO', async () => {
		const root = await fixture()
		const exec = vi.fn()
		for (const [pattern, message] of [
			['{1..257}.ts', '256 brace expansions'],
			['{a,b}'.repeat(9), '256 brace expansions'],
			['a'.repeat(4097), '4096 characters'],
		] as const) {
			await expect(collect(walkFilesLocally(root, { pattern, maxEntries: 1 }))).rejects.toThrow(
				message,
			)
			await expect(
				collect(walkFilesViaExec(exec, root, { pattern, maxEntries: 1 })),
			).rejects.toThrow(message)
		}
		expect(io.open).not.toHaveBeenCalled()
		expect(exec).not.toHaveBeenCalled()
		await expect(
			collect(walkFilesLocally(root, { pattern: '{../outside,src}/*.ts', maxEntries: 1 })),
		).rejects.toThrow('escapes')
	})
	it('accepts exactly 256 brace branches without truncating the last alternative', async () => {
		const root = await fixture()
		await writeFile(join(root, '256.ts'), 'x')
		const entries = await collect(
			walkFilesLocally(root, { pattern: '{1..256}.ts', maxEntries: 10 }),
		)
		expect(entries.map((entry) => entry.path)).toEqual([join(root, '256.ts')])
	})
	it('preserves Unicode flags for matching and directory pruning, including mixed-flag branches', async () => {
		const root = await fixture()
		await writeFile(join(root, 'é.ts'), 'x')
		await mkdir(join(root, 'é'))
		await writeFile(join(root, 'é/one.ts'), 'x')
		for (const [pattern, expected] of [
			['[[:alpha:]].ts', ['é.ts']],
			['[[:alpha:]]/*.ts', ['é/one.ts']],
			['{[[:alpha:]].ts,top.ts}', ['é.ts', 'top.ts']],
		] as const) {
			const entries = await collect(walkFilesLocally(root, { pattern, maxEntries: 10 }))
			expect(entries.map((entry) => entry.path).sort()).toEqual(
				expected.map((name) => join(root, name)).sort(),
			)
		}
	})
	it('prunes unrelated directories and finite pattern depth before opening them', async () => {
		const root = await fixture()
		const entries = await collect(
			walkFilesLocally(root, { pattern: 'src/*.{ts,js}', maxEntries: 10 }),
		)
		expect(entries.map((entry) => entry.path).sort()).toEqual([
			join(root, 'src/one.ts'),
			join(root, 'src/two.js'),
		])
		expect(io.open.mock.calls.map(([path]) => path)).toEqual([join(root, 'src')])
	})
	it('keeps explicit hidden paths and slash-bearing brace alternatives correct', async () => {
		const root = await fixture()
		for (const [pattern, expected] of [
			['.env', ['.env']],
			['.config/*.json', ['.config/value.json']],
			['{.config,src}/*.{json,ts}', ['.config/value.json', 'src/one.ts']],
			['{a/b,c}/x', ['a/b/x', 'c/x']],
		] as const) {
			const entries = await collect(walkFilesLocally(root, { pattern, maxEntries: 20 }))
			expect(entries.map((entry) => entry.path).sort()).toEqual(
				expected.map((name) => join(root, name)).sort(),
			)
		}
		const ordinary = await collect(walkFilesLocally(root, { maxEntries: 30 }))
		expect(
			ordinary.some((entry) => entry.path.includes('.config') || entry.path.endsWith('.env')),
		).toBe(false)
		const hidden = await collect(walkFilesLocally(root, { maxEntries: 30, includeHidden: true }))
		expect(hidden.some((entry) => entry.path.endsWith('.env'))).toBe(true)
	})
	it('honors explicit depth and closes before opening another directory at its result cap', async () => {
		const root = await fixture()
		const entries = await collect(walkFilesLocally(root, { maxDepth: 1, maxEntries: 20 }))
		expect(entries.map((entry) => entry.path)).toEqual([join(root, 'top.ts')])
		io.open.mockClear()
		const one = await collect(walkFilesLocally(root, { pattern: 'src/*.ts', maxEntries: 1 }))
		expect(one).toHaveLength(1)
		expect(io.open.mock.calls.map(([path]) => path)).toEqual([join(root, 'src')])
	})
	it('throws an explicit traversal limit even when no file matches', async () => {
		const root = await fixture()
		await expect(
			collect(
				walkFilesLocally(root, { pattern: '**/*.missing', maxEntries: 10, maxVisitedEntries: 2 }),
			),
		).rejects.toMatchObject({ code: 'ERR_FILE_WALK_LIMIT' })
	})
	it('does not follow symlinks in traversal or an optimized static prefix', async () => {
		const root = await fixture()
		try {
			await symlink(join(root, 'src'), join(root, 'link'), 'dir')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') return
			throw error
		}
		expect(
			await collect(walkFilesLocally(root, { pattern: 'link/**/*.ts', maxEntries: 10 })),
		).toEqual([])
		await expect(
			collect(walkFilesLocally(join(root, 'link/deep'), { maxEntries: 10 })),
		).rejects.toThrow('symbolic link')
		const entries = await collect(walkFilesLocally(root, { maxEntries: 30 }))
		expect(entries.some((entry) => entry.path.includes('/link/'))).toBe(false)
	})
	it('returns an empty listing for a missing root and rejects invalid limits before IO', async () => {
		const root = await fixture()
		expect(await collect(walkFilesLocally(join(root, 'missing'), { maxEntries: 1 }))).toEqual([])
		io.open.mockClear()
		for (const maxEntries of [0, -1, Number.POSITIVE_INFINITY, 1.5])
			await expect(collect(walkFilesLocally(root, { maxEntries }))).rejects.toThrow(
				'positive safe integer',
			)
		await expect(
			collect(walkFilesLocally(root, { pattern: '../*', maxEntries: 1 })),
		).rejects.toThrow('relative')
		expect(io.open).not.toHaveBeenCalled()
	})
	it('cancels pending opendir immediately and closes a handle returned later', async () => {
		const root = await fixture()
		const opened = deferred<Dir>()
		const started = deferred<void>()
		const closed = deferred<void>()
		const close = vi.fn(async () => {
			closed.resolve()
		})
		io.open.mockImplementationOnce(() => {
			started.resolve()
			return opened.promise
		})
		const controller = new AbortController()
		const iterator = walkFilesLocally(root, { maxEntries: 1, signal: controller.signal })
		const pending = iterator.next()
		await started.promise
		controller.abort(new Error('stop pending open'))
		await expect(pending).rejects.toThrow('stop pending open')
		opened.resolve({ close } as unknown as Dir)
		await closed.promise
		expect(close).toHaveBeenCalledOnce()
	})
	it('cancels a blocked read without awaiting its blocked close or starting another IO', async () => {
		const root = await fixture()
		const read = deferred<Dirent | null>()
		const reading = deferred<void>()
		const closeWait = deferred<void>()
		const close = vi.fn(() => closeWait.promise)
		const readCall = vi.fn(() => {
			reading.resolve()
			return read.promise
		})
		io.open.mockResolvedValueOnce({ read: readCall, close })
		const controller = new AbortController()
		const iterator = walkFilesLocally(root, { maxEntries: 1, signal: controller.signal })
		const pending = iterator.next()
		await reading.promise
		controller.abort(new Error('stop pending read'))
		await expect(pending).rejects.toThrow('stop pending read')
		expect(close).toHaveBeenCalledOnce()
		read.resolve(null)
		closeWait.resolve()
		expect(readCall).toHaveBeenCalledOnce()
	})
})

describe('bounded remote file enumeration', () => {
	it('yields streamed filenames exactly and cancels its owned execution on return', async () => {
		const ready = deferred<SandboxExecOptions>()
		const finish = deferred<SandboxExecResult>()
		const exec = vi.fn(async (_command, _argv, opts) => {
			ready.resolve(opts)
			return await finish.promise
		})
		const iterator = walkFilesViaExec(exec, '/workspace', { maxEntries: 2 })
		const first = iterator.next()
		const opts = await ready.promise
		opts.onOutput?.({ stream: 'stdout', data: line('/workspace/a\nb\t😀') })
		expect(await first).toEqual({ done: false, value: { path: '/workspace/a\nb\t😀', size: 1 } })
		const cancelled = deferred<void>()
		opts.signal?.addEventListener('abort', () => cancelled.resolve(), { once: true })
		const ending = iterator.return(undefined)
		await cancelled.promise
		expect(opts.signal?.aborted).toBe(true)
		finish.resolve({ ...complete, exitCode: -1 })
		await expect(ending).resolves.toMatchObject({ done: true })
	})
	it('propagates unconfirmed remote cancellation instead of concealing it during iterator return', async () => {
		const ready = deferred<SandboxExecOptions>()
		const finish = deferred<SandboxExecResult>()
		const iterator = walkFilesViaExec(
			async (_command, _argv, opts) => {
				ready.resolve(opts as SandboxExecOptions)
				return await finish.promise
			},
			'/workspace',
			{ maxEntries: 2 },
		)
		const first = iterator.next()
		const opts = await ready.promise
		opts.onOutput?.({ stream: 'stdout', data: line('/workspace/a') })
		await first
		const ending = iterator.return(undefined)
		finish.reject(new Error('remote cancellation unconfirmed'))
		await expect(ending).rejects.toThrow('remote cancellation unconfirmed')
	})
	it('keeps partial entries before an explicit traversal-limit error', async () => {
		const received: SandboxFileEntry[] = []
		const stream = walkFilesViaExec(
			async () => ({
				...complete,
				exitCode: 1,
				stdout: `${line('/workspace/a')}${JSON.stringify({ type: 'error', code: 'ERR_FILE_WALK_LIMIT', message: 'search incomplete' })}\n`,
			}),
			'/workspace',
			{ maxEntries: 2 },
		)
		await expect(
			(async () => {
				for await (const entry of stream) received.push(entry)
			})(),
		).rejects.toMatchObject({ code: 'ERR_FILE_WALK_LIMIT' })
		expect(received).toEqual([{ path: '/workspace/a', size: 1 }])
	})
	it.each([
		{ stdout: '{bad}\n', error: /JSON|property/i },
		{ stdout: line('/outside/a'), error: /escaped/ },
		{ stdout: line('/workspace/a'), error: /completion/ },
		{ stdout: '{"type":"done"}', error: /incomplete/ },
		{ stdout: '{"type":"done"}\n', stdoutTruncated: true, error: /truncated/ },
		{ stdout: '{"type":"done"}\n', timedOut: true, error: /timed out/ },
		{ stdout: '{"type":"done"}\n', exitCode: 2, error: /exit code 2/ },
		{ stdout: line('/workspace/a') + line('/workspace/b'), error: /entry bound/ },
		{ stdout: 'x'.repeat(65_537), error: /output bound/ },
	])('refuses invalid or incomplete transport ($error)', async ({ error, ...result }) => {
		await expect(
			collect(
				walkFilesViaExec(async () => ({ ...complete, ...result }), '/workspace', { maxEntries: 1 }),
			),
		).rejects.toThrow(error)
	})
	it('does not contact the provider for an already canceled request', async () => {
		const exec = vi.fn()
		const controller = new AbortController()
		controller.abort(new Error('already stopped'))
		await expect(
			collect(walkFilesViaExec(exec, '/workspace', { maxEntries: 1, signal: controller.signal })),
		).rejects.toThrow('already stopped')
		expect(exec).not.toHaveBeenCalled()
	})
	it.each([new Error('provider failed'), 'provider failed', null])(
		'preserves execution rejection %s',
		async (reason) => {
			await expect(
				collect(
					walkFilesViaExec(
						async () => {
							throw reason
						},
						'/workspace',
						{ maxEntries: 1 },
					),
				),
			).rejects.toThrow()
		},
	)
})
