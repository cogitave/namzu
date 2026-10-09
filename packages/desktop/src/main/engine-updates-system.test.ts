import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	type ExecFileLike,
	type FetchLike,
	engineUpdateCacheFile,
	registryBase,
	registryLatest,
	shimTextOf,
	versionRunner,
} from './engine-updates-system.js'

const directories: string[] = []
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function recorder(output: { stdout?: string; stderr?: string; error?: Error }) {
	const calls: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = []
	const run: ExecFileLike = (file, args, options, callback) => {
		calls.push({ file, args, options: options as unknown as Record<string, unknown> })
		callback(output.error ?? null, output.stdout ?? '', output.stderr ?? '')
		return undefined
	}
	return { calls, run }
}

describe('reading a program’s version', () => {
	it('runs the program itself with --version, hidden, with a short timeout and no shell', async () => {
		const { calls, run } = recorder({ stdout: 'codex-cli 0.154.0\n' })
		const version = await versionRunner({ platform: 'linux', run, env: { PATH: '/bin' } })({
			path: '/h/.npm-global/bin/codex',
			shim: false,
		})
		expect(version).toBe('0.154.0')
		expect(calls[0]).toMatchObject({ file: '/h/.npm-global/bin/codex', args: ['--version'] })
		expect(calls[0]?.options).toMatchObject({ windowsHide: true, timeout: 8000 })
		expect(calls[0]?.options.shell).toBeUndefined()
	})

	it('reads Claude Code’s line', async () => {
		const { run } = recorder({ stdout: '2.1.290 (Claude Code)\n' })
		expect(await versionRunner({ platform: 'linux', run })({ path: '/c', shim: false })).toBe(
			'2.1.290',
		)
	})

	it('sends an npm shim through Command Prompt on one fixed line', async () => {
		const { calls, run } = recorder({ stdout: 'codex-cli 0.154.0' })
		await versionRunner({
			platform: 'win32',
			commandPrompt: 'C:\\Windows\\System32\\cmd.exe',
			run,
		})({
			path: 'C:\\Users\\Arda\\AppData\\Roaming\\npm\\codex.cmd',
			shim: true,
		})
		expect(calls[0]).toMatchObject({
			file: 'C:\\Windows\\System32\\cmd.exe',
			args: ['/d', '/s', '/c', '"C:\\Users\\Arda\\AppData\\Roaming\\npm\\codex.cmd" --version'],
		})
		expect(calls[0]?.options.windowsVerbatimArguments).toBe(true)
	})

	it('does not hand Command Prompt a path that holds syntax', async () => {
		const { calls, run } = recorder({ stdout: '1.2.3' })
		const version = await versionRunner({ platform: 'win32', run })({
			path: 'C:\\a&calc\\codex.cmd',
			shim: true,
		})
		expect(version).toBeUndefined()
		expect(calls).toEqual([])
	})

	it('does not pass on the app’s own Node mode', async () => {
		const { calls, run } = recorder({ stdout: '1.2.3' })
		await versionRunner({
			platform: 'linux',
			run,
			env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' },
		})({
			path: '/c',
			shim: false,
		})
		const env = calls[0]?.options.env as Record<string, string | undefined>
		expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
		expect(env.PATH).toBe('/bin')
	})

	it('trusts nothing from a program that failed', async () => {
		const { run } = recorder({ stdout: '9.9.9', error: new Error('timed out') })
		expect(
			await versionRunner({ platform: 'linux', run })({ path: '/c', shim: false }),
		).toBeUndefined()
	})
})

describe('the registry', () => {
	it('is npm’s unless this machine names its own', () => {
		expect(registryBase({}, { packaged: true })).toBe('https://registry.npmjs.org')
		expect(
			registryBase({ NAMZU_ENGINE_REGISTRY: 'http://127.0.0.1:5000/' }, { packaged: true }),
		).toBe('http://127.0.0.1:5000')
		expect(
			registryBase({ NAMZU_ENGINE_REGISTRY: 'https://evil.example/' }, { packaged: true }),
		).toBe('https://registry.npmjs.org')
		expect(
			registryBase({ NAMZU_ENGINE_REGISTRY: 'https://mirror.example/' }, { packaged: false }),
		).toBe('https://mirror.example')
		expect(registryBase({ NAMZU_ENGINE_REGISTRY: 'file:///x' }, { packaged: false })).toBe(
			'https://registry.npmjs.org',
		)
		expect(registryBase({ NAMZU_ENGINE_REGISTRY: 'nonsense' }, { packaged: false })).toBe(
			'https://registry.npmjs.org',
		)
	})

	const answering =
		(body: string, ok = true): FetchLike =>
		async () => ({ ok, text: async () => body })

	it('asks for the package’s latest and reads only its version', async () => {
		const urls: string[] = []
		const latest = registryLatest({
			base: 'https://registry.npmjs.org',
			fetch: async (url, init) => {
				urls.push(url)
				expect(init.headers.accept).toBe('application/json')
				return {
					ok: true,
					text: async () => JSON.stringify({ version: '0.162.0', dist: { x: 1 } }),
				}
			},
		})
		expect(await latest('@openai/codex')).toBe('0.162.0')
		expect(urls).toEqual(['https://registry.npmjs.org/@openai/codex/latest'])
	})

	it.each([
		['an alpha', JSON.stringify({ version: '0.163.0-alpha.1' })],
		['no version', JSON.stringify({})],
		['not an object', '"0.1.0"'],
		['not JSON', '<html>'],
		['a version-looking injection', JSON.stringify({ version: '1.2.3; rm -rf' })],
	])('gives nothing for %s', async (_name, body) => {
		expect(await registryLatest({ base: 'http://x', fetch: answering(body) })('p')).toBeUndefined()
	})

	it('gives nothing for an error status or a failed request', async () => {
		expect(
			await registryLatest({ base: 'http://x', fetch: answering('{"version":"1.0.0"}', false) })(
				'p',
			),
		).toBeUndefined()
		expect(
			await registryLatest({
				base: 'http://x',
				fetch: async () => {
					throw new Error('offline')
				},
			})('p'),
		).toBeUndefined()
	})
})

describe('the cache on disk', () => {
	it('keeps the registry answers and the versions announced across runs', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-engine-cache-'))
		directories.push(directory)
		const file = join(directory, 'nested', 'engine-updates.json')
		const store = engineUpdateCacheFile(file)
		expect(store.read()).toEqual({ latest: {}, announced: {} })
		store.write({
			latest: { 'codex-cli': { version: '0.162.0', checkedAt: 5 } },
			announced: { 'codex-cli': '0.162.0' },
		})
		expect(engineUpdateCacheFile(file).read()).toEqual({
			latest: { 'codex-cli': { version: '0.162.0', checkedAt: 5 } },
			announced: { 'codex-cli': '0.162.0' },
		})
		expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1)
	})

	it('ignores a foreign, damaged or hostile file', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-engine-cache-'))
		directories.push(directory)
		const file = join(directory, 'c.json')
		for (const content of [
			'not json',
			'null',
			JSON.stringify({ version: 2, latest: {} }),
			JSON.stringify({
				version: 1,
				latest: {
					'codex-cli': { version: '1.2.3; x', checkedAt: 1 },
					'claude-code': { version: '2.0.0', checkedAt: 'now' },
					'namzu-cli': { version: '3.0.0', checkedAt: 7 },
					'other-engine': { version: '9.9.9', checkedAt: 7 },
				},
				announced: { 'codex-cli': { not: 'a version' } },
			}),
		]) {
			await writeFile(file, content)
			const cache = engineUpdateCacheFile(file).read()
			expect(cache.latest['codex-cli']).toBeUndefined()
			expect(cache.latest['claude-code']).toBeUndefined()
			expect(Object.keys(cache.latest)).toEqual(
				content.includes('"namzu-cli"') ? ['namzu-cli'] : [],
			)
			expect(cache.announced).toEqual({})
		}
	})

	it('reports a folder it cannot write and keeps going', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-engine-cache-'))
		directories.push(directory)
		// A file where the folder should be: the write cannot succeed on any platform.
		await writeFile(join(directory, 'blocker'), 'x')
		const errors: unknown[] = []
		const store = engineUpdateCacheFile(join(directory, 'blocker', 'c.json'), (error) =>
			errors.push(error),
		)
		store.write({ latest: {}, announced: {} })
		expect(errors).toHaveLength(1)
	})
})

describe('reading an npm shim', () => {
	it('returns the start of a small script and nothing for a missing file', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'namzu-engine-shim-'))
		directories.push(directory)
		const file = join(directory, 'codex.cmd')
		await writeFile(file, `@ECHO off\r\n${'x'.repeat(10_000)}`)
		const text = shimTextOf(file)
		expect(text?.startsWith('@ECHO off')).toBe(true)
		expect(text?.length).toBe(4096)
		expect(shimTextOf(join(directory, 'absent.cmd'))).toBeUndefined()
	})
})
