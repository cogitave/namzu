import { EventEmitter } from 'node:events'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bakedFeedDeclared } from './updater.js'

const { stripNodePty, writeAppUpdateYml, verifyPacked, packedExecutable } = createRequire(
	import.meta.url,
)('../../scripts/installer-after-pack.cjs') as {
	packedExecutable(appOutDir: string, platform: string, productFilename: string): string
	verifyPacked(
		context: unknown,
		target: Target,
		deps?: { spawn?: Spawn; host?: Target; log?: (line: string) => void },
	): Promise<{ skipped?: boolean }>
	writeAppUpdateYml(file: string): void
	stripNodePty(dir: string, target: { platform: string; arch: string }): boolean
}
type Target = { platform: string; arch: string }
type Spawn = (program: string, args: string[], options: Record<string, any>) => any
type Smoke = {
	runPackedSmoke(input: Record<string, unknown>): Promise<{
		skipped?: boolean
		reason?: string
		failures: string[]
		report: { version?: string; initialized: boolean; killedAfterInitialize: boolean }
	}>
	probeScript(names: string[]): string
}
const smoke = (await import(
	/* @vite-ignore */ new URL('../../scripts/packed-smoke.mjs', import.meta.url).href
)) as Smoke
const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-after-pack-'))
	roots.push(dir)
	const files = [
		'package.json',
		'lib/index.js',
		'typings/node-pty.d.ts',
		'prebuilds/win32-x64/pty.node',
		'prebuilds/win32-x64/pty.pdb',
		'prebuilds/win32-x64/conpty.node',
		'prebuilds/win32-x64/winpty-agent.exe',
		'prebuilds/win32-x64/conpty/OpenConsole.exe',
		'prebuilds/win32-x64/conpty/OpenConsole.pdb',
		'prebuilds/win32-arm64/pty.node',
		'prebuilds/darwin-arm64/pty.node',
		'build/Release/pty.node',
		'src/win/conpty.cc',
		'deps/winpty/x.cc',
		'third_party/conpty/x.dll',
		'scripts/prebuild.js',
		'binding.gyp',
		'node-addon-api@7.1.1/napi.h',
	]
	for (const file of files) {
		mkdirSync(join(dir, file, '..'), { recursive: true })
		writeFileSync(join(dir, file), '')
	}
	return dir
}
const tree = (dir: string, prefix = ''): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? tree(join(dir, entry.name), `${prefix}${entry.name}/`)
			: [`${prefix}${entry.name}`],
	)

it('keeps the target platform binaries and what loads them, and nothing else', () => {
	const dir = fixture()
	expect(stripNodePty(dir, { platform: 'win32', arch: 'x64' })).toBe(true)
	expect(tree(dir).sort()).toEqual([
		'lib/index.js',
		'package.json',
		'prebuilds/win32-x64/conpty.node',
		'prebuilds/win32-x64/conpty/OpenConsole.exe',
		'prebuilds/win32-x64/pty.node',
		'prebuilds/win32-x64/winpty-agent.exe',
		'typings/node-pty.d.ts',
	])
})

it('fails loudly when the package has no binary for the platform', () => {
	const dir = fixture()
	expect(() => stripNodePty(dir, { platform: 'win32', arch: 'ia32' })).toThrow(/win32-ia32/)
})

it('reports a runtime without the package', () => {
	expect(
		stripNodePty(join(tmpdir(), 'namzu-no-such-node-pty'), { platform: 'win32', arch: 'x64' }),
	).toBe(false)
})

function ymlPath() {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-app-update-'))
	roots.push(dir)
	return join(dir, 'app-update.yml')
}
const BUILT = [
	'provider: generic',
	'url: https://github.com/cogitave/namzu/releases/download/desktop-latest/',
	'useMultipleRangeRequest: false',
]

it('keeps the feed electron-builder wrote and sets the cache folder name once', () => {
	const file = ymlPath()
	writeFileSync(file, `${[...BUILT, 'updaterCacheDirName: namzu-desktop-updater'].join('\n')}\n`)
	writeAppUpdateYml(file)
	expect(readFileSync(file, 'utf8')).toBe(
		`${[...BUILT, 'updaterCacheDirName: namzu-updater'].join('\n')}\n`,
	)
})

it('appends the cache folder name when the file has none', () => {
	const file = ymlPath()
	writeFileSync(file, `${BUILT.join('\n')}\n`)
	writeAppUpdateYml(file)
	expect(readFileSync(file, 'utf8')).toBe(
		`${[...BUILT, 'updaterCacheDirName: namzu-updater'].join('\n')}\n`,
	)
})

it('writes a cache-only file when electron-builder wrote none', () => {
	const file = ymlPath()
	writeAppUpdateYml(file)
	expect(readFileSync(file, 'utf8')).toBe('updaterCacheDirName: namzu-updater\n')
	expect(bakedFeedDeclared(readFileSync(file, 'utf8'))).toBe(false)
})

it('keeps the publish block of electron-builder.yml what bakedFeedDeclared reads as a feed', () => {
	const config = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8')
	const block = /^publish:\s*\n((?:[ \t]+.*\n?)+)/m.exec(config)?.[1] ?? ''
	expect(block).toMatch(/^\s+provider:\s*generic\s*$/m)
	expect(block).toMatch(
		/^\s+url:\s*https:\/\/github\.com\/cogitave\/namzu\/releases\/download\/desktop-latest\/\s*$/m,
	)
	const file = ymlPath()
	writeFileSync(file, `${BUILT.join('\n')}\n`)
	writeAppUpdateYml(file)
	expect(bakedFeedDeclared(readFileSync(file, 'utf8'))).toBe(true)
})

// The packed-engine check: a fake packed tree and a fake spawn stand in for a Windows build machine.
const WIN: Target = { platform: 'win32', arch: 'x64' }
const LINUX: Target = { platform: 'linux', arch: 'x64' }
const VERSION = '1.2.3'

function packedTree() {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-packed-'))
	roots.push(dir)
	const cli = join(dir, 'resources', 'cli')
	for (const file of ['dist/bin.js', 'skills/one.md', 'assets/a.py']) {
		mkdirSync(join(cli, file, '..'), { recursive: true })
		writeFileSync(join(cli, file), '')
	}
	writeFileSync(join(cli, 'package.json'), JSON.stringify({ version: VERSION }))
	writeFileSync(join(dir, 'Namzu.exe'), '')
	return { dir, cli, exe: join(dir, 'Namzu.exe') }
}

type Mode = {
	version?: 'ok' | 'wrong' | 'crash' | 'hang'
	init?: 'ok' | 'error' | 'exit' | 'silent' | 'stays'
	probe?: 'ok' | 'bad' | 'mute'
}
function fakeSpawn(mode: Mode = {}) {
	const calls: {
		program: string
		args: string[]
		options: Record<string, any>
		kill: any
		stdin?: any
	}[] = []
	const spawn: Spawn = (program, args, options) => {
		const child: any = new EventEmitter()
		child.pid = 100 + calls.length
		child.stdout = new EventEmitter()
		child.stderr = new EventEmitter()
		child.kill = vi.fn()
		child.stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() }
		const call = { program, args, options, kill: child.kill, stdin: child.stdin }
		calls.push(call)
		const close = (code: number) => queueMicrotask(() => child.emit('close', code))
		if (program === 'taskkill') return child
		if (args.includes('--version')) {
			const m = mode.version ?? 'ok'
			if (m === 'hang') return child
			queueMicrotask(() => {
				child.stdout.emit('data', m === 'wrong' ? 'namzu 9.9.9\n' : `namzu ${VERSION}\n`)
				if (m === 'crash') child.stderr.emit('data', 'Error: Cannot find module x')
				child.emit('close', m === 'crash' ? 1 : 0)
			})
		} else if (args.includes('acp')) {
			const m = mode.init ?? 'ok'
			if (m === 'exit') {
				queueMicrotask(() => child.stderr.emit('data', 'boom: no such module'))
				close(1)
			}
			child.stdin.write = vi.fn((line: string) => {
				const id = JSON.parse(line).id
				if (m === 'ok' || m === 'stays' || m === 'error')
					queueMicrotask(() => {
						child.stdout.emit(
							'data',
							`${JSON.stringify(m === 'error' ? { jsonrpc: '2.0', id, error: { code: -1 } } : { jsonrpc: '2.0', id, result: { ok: 1 } })}\n`,
						)
					})
			})
			child.stdin.end = vi.fn(() => {
				if (m !== 'stays') close(0)
			})
		} else if (args.includes('-e')) {
			const m = mode.probe ?? 'ok'
			queueMicrotask(() => {
				if (m !== 'mute')
					child.stdout.emit(
						'data',
						`noise\nNAMZU_SMOKE ${JSON.stringify(m === 'bad' ? [{ name: 'sharp', message: 'no binary for win32-x64' }] : [])}\n`,
					)
				child.emit('close', 0)
			})
		}
		return child
	}
	return { spawn, calls }
}

const run = (
	tree: ReturnType<typeof packedTree>,
	mode: Mode,
	extra: Record<string, unknown> = {},
) => {
	const fake = fakeSpawn(mode)
	return {
		fake,
		result: smoke.runPackedSmoke({
			target: WIN,
			host: WIN,
			exe: tree.exe,
			cliDir: tree.cli,
			natives: ['sharp', 'oxc-parser', '@lydell/node-pty'],
			requiredFiles: ['dist/bin.js', 'skills/'],
			scratchRoot: tmpdir(),
			spawn: fake.spawn,
			baseEnv: { PATH: 'p', NODE_PATH: '/elsewhere', NODE_OPTIONS: '--x', WSL_DISTRO_NAME: 'u' },
			...extra,
		}),
	}
}

describe('the packed engine check', () => {
	it('is skipped, with the reason, when the host is not the target, and starts nothing', async () => {
		const tree = packedTree()
		const { fake, result } = run(tree, {}, { host: LINUX })
		const out = await result
		expect(out.skipped).toBe(true)
		expect(out.reason).toMatch(/linux-x64.*win32-x64/)
		expect(fake.calls).toEqual([])
	})

	it('runs the version, initialize and native checks with the packed executable as Node', async () => {
		const tree = packedTree()
		const { fake, result } = run(tree, {})
		const out = await result
		expect(out.failures).toEqual([])
		expect(out.report).toMatchObject({
			version: `namzu ${VERSION}`,
			initialized: true,
			killedAfterInitialize: false,
		})
		const bin = join(tree.cli, 'dist', 'bin.js')
		expect(fake.calls.map((c) => c.args.slice(0, 2))).toEqual([
			[bin, '--version'],
			[bin, 'acp'],
			['--input-type=module', '-e'],
		])
		const homes = new Set<string>()
		for (const call of fake.calls) {
			expect(call.program).toBe(tree.exe)
			expect(call.options.cwd).toBe(tree.cli)
			const env = call.options.env
			expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
			expect(env.NODE_PATH).toBeUndefined()
			expect(env.NODE_OPTIONS).toBeUndefined()
			expect(env.WSL_DISTRO_NAME).toBeUndefined()
			expect(env.NAMZU_HOME).toBe(join(env.HOME, 'namzu'))
			expect(env.HOME.startsWith(join(tmpdir(), 'namzu-packed-smoke-'))).toBe(true)
			homes.add(env.HOME)
		}
		expect(homes.size).toBe(1)
		expect(existsSync([...homes][0])).toBe(false)
		expect(fake.calls[1].args).toEqual([bin, 'acp', '--desktop'])
		expect(fake.calls[1].stdin.write.mock.calls[0][0]).toContain('"method":"initialize"')
		expect(fake.calls[1].stdin.end).toHaveBeenCalled()
		const script = fake.calls[2].args[2]
		for (const name of ['sharp', 'oxc-parser', '@lydell/node-pty'])
			expect(script).toContain(`import("${name}")`)
		expect(script).toContain('let a = 1')
		expect(script).toContain('metadata()')
		expect(script).not.toMatch(/\.spawn\(/)
	})

	it('names a wrong version', async () => {
		const { result } = run(packedTree(), { version: 'wrong' })
		expect((await result).failures).toEqual([
			expect.stringMatching(/--version should print 1\.2\.3.*namzu 9\.9\.9/),
		])
	})

	it('names an engine that crashes on start', async () => {
		const { result } = run(packedTree(), { version: 'crash' })
		expect((await result).failures[0]).toMatch(/--version.*exited 1.*Cannot find module x/)
	})

	it('names an initialize that is not answered because the engine exited', async () => {
		const { result } = run(packedTree(), { init: 'exit' })
		expect((await result).failures).toEqual([
			expect.stringMatching(
				/acp --desktop exited \(1\) before it answered initialize: boom: no such module/,
			),
		])
	})

	it('names an initialize that answers with an error', async () => {
		const { result } = run(packedTree(), { init: 'error' })
		expect((await result).failures[0]).toMatch(/answered initialize with .*"error"/)
	})

	it('names a native package that does not work, with its reason', async () => {
		const { result } = run(packedTree(), { probe: 'bad' })
		expect((await result).failures).toEqual([
			'the native package sharp does not work from the packed runtime: no binary for win32-x64',
		])
	})

	it('fails when the probe prints nothing', async () => {
		const { result } = run(packedTree(), { probe: 'mute' })
		expect((await result).failures[0]).toMatch(/probe did not report/)
	})

	it('names a file loaded by path that is not in the packed tree', async () => {
		const tree = packedTree()
		const { result } = run(
			tree,
			{},
			{ requiredFiles: ['dist/bin.js', 'CHANGELOG.md', 'skills/', 'empty/'] },
		)
		mkdirSync(join(tree.cli, 'empty'))
		const out = await result
		expect(out.failures).toEqual([
			'the packed runtime is missing CHANGELOG.md, which the engine loads by path',
			'the packed runtime is missing empty/, which the engine loads by path',
		])
	})

	it('fails without starting anything when the packed program is missing', async () => {
		const tree = packedTree()
		rmSync(tree.exe)
		const { fake, result } = run(tree, {})
		expect((await result).failures).toEqual([expect.stringMatching(/Namzu\.exe does not exist/)])
		expect(fake.calls).toEqual([])
	})

	describe('with a clock', () => {
		it('kills a version check that hangs, by handle and by pid', async () => {
			vi.useFakeTimers()
			try {
				const tree = packedTree()
				const { fake, result } = run(tree, { version: 'hang' }, { platform: 'win32' })
				await vi.advanceTimersByTimeAsync(61_000)
				const out = await result
				expect(out.failures[0]).toMatch(/did not print its version within 60 s/)
				const hung = fake.calls[0]
				expect(hung.kill).toHaveBeenCalled()
				expect(
					fake.calls.some((c) => c.program === 'taskkill' && c.args.includes(String(100))),
				).toBe(true)
			} finally {
				vi.useRealTimers()
			}
		})

		it('kills an engine that never answers initialize', async () => {
			vi.useFakeTimers()
			try {
				const { fake, result } = run(packedTree(), { init: 'silent' })
				await vi.advanceTimersByTimeAsync(61_000)
				const out = await result
				expect(out.failures).toEqual([
					expect.stringMatching(/did not answer initialize within 60 s/),
				])
				expect(fake.calls[1].kill).toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it('stops an engine that outlives the end of its input, and says so without failing', async () => {
			vi.useFakeTimers()
			try {
				const { fake, result } = run(packedTree(), { init: 'stays' })
				await vi.advanceTimersByTimeAsync(16_000)
				const out = await result
				expect(out.failures).toEqual([])
				expect(out.report.killedAfterInitialize).toBe(true)
				expect(fake.calls[1].kill).toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})
	})
})

describe('the hook around it', () => {
	function context(tree: ReturnType<typeof packedTree>, projectDir: string) {
		return {
			appOutDir: tree.dir,
			packager: { projectDir, appInfo: { productFilename: 'Namzu' } },
		}
	}
	const manifest = JSON.stringify({
		target: 'win32-x64',
		natives: ['sharp'],
		requiredFiles: ['dist/bin.js'],
	})

	it('finds the packed executable of each platform', () => {
		expect(packedExecutable('/o', 'win32', 'Namzu')).toBe(join('/o', 'Namzu.exe'))
		expect(packedExecutable('/o', 'darwin', 'Namzu')).toBe(
			join('/o', 'Namzu.app', 'Contents', 'MacOS', 'Namzu'),
		)
	})

	it('reports a skip on another host and does not fail', async () => {
		const tree = packedTree()
		const project = mkdtempSync(join(tmpdir(), 'namzu-project-'))
		roots.push(project)
		writeFileSync(join(project, 'packed-smoke.json'), manifest)
		const log = vi.fn()
		const { spawn, calls } = fakeSpawn()
		const out = await verifyPacked(context(tree, project), WIN, { spawn, host: LINUX, log })
		expect(out.skipped).toBe(true)
		expect(log.mock.calls[0][0]).toMatch(/skipped: .*linux-x64.*win32-x64/)
		expect(calls).toEqual([])
	})

	it('fails the packaging with a plain message naming what is wrong', async () => {
		const tree = packedTree()
		const project = mkdtempSync(join(tmpdir(), 'namzu-project-'))
		roots.push(project)
		writeFileSync(join(project, 'packed-smoke.json'), manifest)
		const { spawn } = fakeSpawn({ probe: 'bad' })
		await expect(
			verifyPacked(context(tree, project), WIN, { spawn, host: WIN, log: vi.fn() }),
		).rejects.toThrow(
			/does not work, so it was not produced:\n {2}the native package sharp does not work/,
		)
	})

	it('passes and says what it checked', async () => {
		const tree = packedTree()
		const project = mkdtempSync(join(tmpdir(), 'namzu-project-'))
		roots.push(project)
		writeFileSync(join(project, 'packed-smoke.json'), manifest)
		const log = vi.fn()
		const { spawn } = fakeSpawn()
		await verifyPacked(context(tree, project), WIN, { spawn, host: WIN, log })
		expect(log.mock.calls[0][0]).toMatch(
			/passed: --version namzu 1\.2\.3.*1 native packages loaded \(sharp\)/,
		)
	})

	it('fails when the staged folder has no list to check against, on the target host only', async () => {
		const tree = packedTree()
		const project = mkdtempSync(join(tmpdir(), 'namzu-project-'))
		roots.push(project)
		await expect(
			verifyPacked(context(tree, project), WIN, { host: WIN, log: vi.fn() }),
		).rejects.toThrow(/no packed-smoke\.json/)
		expect(
			(await verifyPacked(context(tree, project), WIN, { host: LINUX, log: vi.fn() })).skipped,
		).toBe(true)
	})
})
