import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { REQUIRED_EXTENSIONS } from '../required-extensions.js'
import { expectedOf } from './kernel-test-support.js'
import {
	type CheckedChild,
	type SpawnChild,
	cleanEnvironment,
	createSelfCheck,
} from './self-check.js'

const folders: string[] = []
afterEach(async () => {
	await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

const expected = expectedOf('52.0.0', '62.14.0')
const INIT_OK = {
	protocolVersion: 1,
	agentInfo: { name: 'namzu' },
	extensions: [...REQUIRED_EXTENSIONS],
	kernel: { engine: '62.14.0', dataEpoch: 1, commandLine: '52.0.0', desktopContract: 1 },
}

/** The program a real child runs: answers like an engine, as far as `mode` says. */
function stubSource(mode: string): string {
	return `
const MODE = ${JSON.stringify(mode)}
const INIT = ${JSON.stringify(INIT_OK)}
if (process.argv[2] === '--version') {
	console.log(MODE === 'wrong-version' ? '51.9.9' : '52.0.0')
	process.exit(MODE === 'version-fails' ? 4 : 0)
}
if (MODE === 'dies') process.exit(5)
let buffer = ''
process.stdin.on('data', (chunk) => {
	buffer += chunk
	for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
		const message = JSON.parse(buffer.slice(0, at))
		buffer = buffer.slice(at + 1)
		if (message.method !== 'initialize') continue
		const result = MODE === 'no-extensions' ? { ...INIT, extensions: [] } : INIT
		process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
	}
})
process.stdin.on('end', () => process.exit(0))
`
}

async function stubEngine(mode: string): Promise<string> {
	const folder = await mkdtemp(join(tmpdir(), 'namzu-selfcheck-test-'))
	folders.push(folder)
	await mkdir(join(folder, 'dist'))
	const entry = join(folder, 'dist', 'bin.js')
	await writeFile(entry, stubSource(mode))
	return entry
}

/** Timers that only fire when the test says so. */
function manualTimers() {
	const pending = new Set<() => void>()
	let arm: () => void = () => undefined
	const armed = new Promise<void>((resolve) => {
		arm = resolve
	})
	return {
		/** Settles once a timer has been set. */
		armed,
		after: (_ms: number, run: () => void) => {
			pending.add(run)
			arm()
			return () => pending.delete(run)
		},
		fireAll: () => {
			for (const run of [...pending]) run()
		},
		count: () => pending.size,
	}
}

function realCheck(
	timers = manualTimers(),
	extra: Partial<Parameters<typeof createSelfCheck>[0]> = {},
) {
	return createSelfCheck({
		program: process.execPath,
		env: { PATH: process.env.PATH, SECRET_TOKEN: 'must-not-reach-the-engine' },
		requiredExtensions: REQUIRED_EXTENSIONS,
		after: timers.after,
		...extra,
	})
}

describe('the self-check with a real child process', () => {
	it('passes an engine that answers --version and initialize as promised', async () => {
		const entry = await stubEngine('ok')
		expect(await realCheck()({ folder: '', entry, expected })).toBeUndefined()
	})

	it('names the problem when --version disagrees, fails, or initialize lacks a method', async () => {
		const check = realCheck()
		const wrong = await stubEngine('wrong-version')
		expect(await check({ folder: '', entry: wrong, expected })).toMatch(/--version says/)
		const failing = await stubEngine('version-fails')
		expect(await check({ folder: '', entry: failing, expected })).toMatch(
			/--version ended with code 4/,
		)
		const missing = await stubEngine('no-extensions')
		expect(await check({ folder: '', entry: missing, expected })).toMatch(/lacks the method/)
		const dies = await stubEngine('dies')
		expect(await check({ folder: '', entry: dies, expected })).toMatch(
			/ended \(code 5\) before answering initialize/,
		)
	})

	it('names the problem when the engine file is not there', async () => {
		expect(
			await realCheck()({
				folder: '',
				entry: join(tmpdir(), 'no-such-engine', 'bin.js'),
				expected,
			}),
		).toMatch(/ended with code|could not start/)
	})
})

/** A child that never answers, with a record of how it was started and stopped. */
function silentChild() {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: new PassThrough(),
		killed: [] as (string | undefined)[],
		kill(signal?: string) {
			child.killed.push(signal)
			return true
		},
	})
	return child as typeof child & CheckedChild
}

describe('the self-check environment and time limit', () => {
	it('runs in a clean environment with a temporary home that is removed afterwards', async () => {
		const seen: { env: NodeJS.ProcessEnv; cwd: string; args: string[] }[] = []
		const timers = manualTimers()
		let home = ''
		const check = createSelfCheck({
			program: 'engine-host',
			env: {
				PATH: '/bin',
				SECRET_TOKEN: 'x',
				OPENAI_API_KEY: 'y',
				HOME: '/home/person',
				USERPROFILE: 'C:/Users/person',
			},
			requiredExtensions: REQUIRED_EXTENSIONS,
			after: timers.after,
			makeHome: async () => {
				home = await mkdtemp(join(tmpdir(), 'namzu-selfcheck-home-'))
				folders.push(home)
				await mkdir(join(home, 'project'))
				return home
			},
			spawn: ((_program, args, options) => {
				seen.push({ env: options.env, cwd: options.cwd, args })
				const child = silentChild()
				queueMicrotask(() => {
					if (args[1] === '--version') {
						child.stdout.write('52.0.0\n')
						child.emit('close', 0)
					} else
						child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: INIT_OK })}\n`)
				})
				return child
			}) as SpawnChild,
		})
		expect(await check({ folder: '', entry: '/engine/dist/bin.js', expected })).toBeUndefined()
		expect(seen).toHaveLength(2)
		for (const call of seen) {
			expect(call.env.SECRET_TOKEN).toBeUndefined()
			expect(call.env.OPENAI_API_KEY).toBeUndefined()
			expect(call.env.PATH).toBe('/bin')
			expect(call.env.HOME).toBe(home)
			expect(call.env.USERPROFILE).toBe(home)
			expect(call.env.ELECTRON_RUN_AS_NODE).toBe('1')
			expect(call.cwd).toBe(join(home, 'project'))
		}
		expect(seen[1]?.args).toEqual(['/engine/dist/bin.js', 'acp', '--desktop'])
		// The temporary home is gone, and no timer is left running.
		await expect(stat(home)).rejects.toThrow()
		expect(timers.count()).toBe(0)
	})

	it('stops a child that does not answer in time, and says which step', async () => {
		const timers = manualTimers()
		const children: ReturnType<typeof silentChild>[] = []
		const check = createSelfCheck({
			program: 'engine-host',
			env: {},
			requiredExtensions: REQUIRED_EXTENSIONS,
			after: timers.after,
			makeHome: async () => {
				const home = await mkdtemp(join(tmpdir(), 'namzu-selfcheck-home-'))
				folders.push(home)
				return home
			},
			spawn: (() => {
				const child = silentChild()
				children.push(child)
				return child
			}) as SpawnChild,
		})
		const running = check({ folder: '', entry: '/engine/dist/bin.js', expected })
		// Wait until the first step has started, then let its time run out.
		await timers.armed
		timers.fireAll()
		expect(await running).toBe('--version did not answer in time')
		expect(children).toHaveLength(1)
		expect(children[0]?.killed).toEqual(['SIGKILL'])
	})

	it('reports a program that cannot be started', async () => {
		const check = createSelfCheck({
			program: 'engine-host',
			env: {},
			requiredExtensions: REQUIRED_EXTENSIONS,
			after: manualTimers().after,
			makeHome: async () => {
				const home = await mkdtemp(join(tmpdir(), 'namzu-selfcheck-home-'))
				folders.push(home)
				return home
			},
			spawn: (() => {
				throw new Error('spawn denied')
			}) as SpawnChild,
		})
		expect(await check({ folder: '', entry: '/engine/dist/bin.js', expected })).toBe(
			'--version could not start (spawn denied)',
		)
	})

	it('keeps only a short allow-list of the caller’s environment', () => {
		const env = cleanEnvironment(
			{
				PATH: '/bin',
				SystemRoot: 'C:\\Windows',
				LANG: 'en',
				ANTHROPIC_API_KEY: 'k',
				USERNAME: 'person',
			},
			'/tmp/h',
		)
		expect(Object.keys(env).sort()).toEqual(
			[
				'APPDATA',
				'CI',
				'ELECTRON_RUN_AS_NODE',
				'HOME',
				'LANG',
				'LOCALAPPDATA',
				'NAMZU_HOME',
				'PATH',
				'SystemRoot',
				'TEMP',
				'TMP',
				'TMPDIR',
				'USERPROFILE',
				'XDG_CACHE_HOME',
				'XDG_CONFIG_HOME',
				'XDG_DATA_HOME',
			].sort(),
		)
	})
})

it('leaves no temporary home behind after a real run', async () => {
	const before = (await readdir(tmpdir())).filter((name) => name.startsWith('namzu-engine-check-'))
	const entry = await stubEngine('ok')
	await realCheck()({ folder: '', entry, expected })
	const after = (await readdir(tmpdir())).filter((name) => name.startsWith('namzu-engine-check-'))
	expect(after.sort()).toEqual(before.sort())
})
