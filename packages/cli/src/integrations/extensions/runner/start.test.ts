import { describe, expect, it } from 'vitest'
import { START_CMD } from '../signin/launcher.js'
import { ensureRunner } from './daemon.js'
import { planRunnerStart, queryTaskExistsArgs, runTaskArgs } from './start.js'

const base = {
	exe: 'C:\\App\\Namzu.exe',
	args: ['C:\\App\\bin.js', 'extension', 'daemon', 'run'],
	env: {},
}

describe('how the runner is started', () => {
	it('runs the registered scheduled task on Windows when it exists', () => {
		const plan = planRunnerStart({ ...base, platform: 'win32', taskExists: true })
		expect(plan).toEqual({
			kind: 'task',
			file: 'schtasks',
			args: ['/run', '/tn', '\\Namzu\\Extension Runner'],
		})
		expect(runTaskArgs()).toEqual(['/run', '/tn', '\\Namzu\\Extension Runner'])
		expect(queryTaskExistsArgs()).toEqual(['/query', '/tn', '\\Namzu\\Extension Runner'])
	})

	it('starts through cmd start on Windows without a task, so no parent of the runner stays alive', () => {
		const plan = planRunnerStart({ ...base, platform: 'win32', taskExists: false })
		expect(plan?.kind).toBe('detached')
		if (plan?.kind !== 'detached') return
		expect(plan.file).toBe('cmd.exe')
		expect(plan.args).toEqual([
			'/d',
			'/s',
			'/c',
			'"start "" /b "C:\\App\\Namzu.exe" "C:\\App\\bin.js" "extension" "daemon" "run""',
		])
		expect(plan.options.windowsVerbatimArguments).toBe(true)
		expect(plan.options.windowsHide).toBe(true)
	})

	it('refuses a command line that cmd would read differently', () => {
		expect(
			planRunnerStart({
				...base,
				exe: 'C:\\100%\\Namzu.exe',
				platform: 'win32',
				taskExists: false,
			}),
		).toBeUndefined()
		expect(
			planRunnerStart({ ...base, args: ['a"b'], platform: 'win32', taskExists: false }),
		).toBeUndefined()
	})

	it('keeps the detached start on Linux and macOS, and never asks about a task', () => {
		for (const platform of ['linux', 'darwin'] as const) {
			const plan = planRunnerStart({ ...base, exe: '/usr/bin/node', platform, taskExists: true })
			expect(plan).toMatchObject({
				kind: 'detached',
				file: '/usr/bin/node',
				args: base.args,
				options: { detached: true, stdio: 'ignore' },
			})
		}
	})
})

describe('ensureRunner on Windows, with nothing really run', () => {
	const engine = { exe: 'C:\\App\\Namzu.exe', args: ['C:\\App\\bin.js'], env: {} }
	it('runs the task and spawns nothing when the task exists', async () => {
		const calls: string[][] = []
		let spawned = 0
		await ensureRunner({
			root: '/nonexistent-root',
			engine,
			platform: 'win32',
			waitMs: 0,
			exec: async (file, args) => {
				calls.push([file, ...args])
				return 0
			},
			spawnDetached: () => {
				spawned++
				return { onExit: () => {} }
			},
		})
		expect(calls).toEqual([
			['schtasks', '/query', '/tn', '\\Namzu\\Extension Runner'],
			['schtasks', '/run', '/tn', '\\Namzu\\Extension Runner'],
		])
		expect(spawned).toBe(0)
	})

	it('starts through cmd when there is no task', async () => {
		const seen: { file: string; args: string[] }[] = []
		await ensureRunner({
			root: '/nonexistent-root',
			engine,
			platform: 'win32',
			waitMs: 0,
			exec: async () => 1,
			spawnDetached: (file, args) => {
				seen.push({ file, args })
				return { onExit: () => {} }
			},
		})
		expect(seen).toHaveLength(1)
		expect(seen[0]?.file).toBe('cmd.exe')
	})

	it('falls back to the cmd start when the task exists but cannot be run', async () => {
		const seen: string[] = []
		await ensureRunner({
			root: '/nonexistent-root',
			engine,
			platform: 'win32',
			waitMs: 0,
			exec: async (_f, args) => (args[0] === '/query' ? 0 : 1),
			spawnDetached: (file) => {
				seen.push(file)
				return { onExit: () => {} }
			},
		})
		expect(seen).toEqual(['cmd.exe'])
	})
})

describe('the sign-in task path ends in a started runner', () => {
	const engine = { exe: 'C:\\App\\Namzu.exe', args: ['C:\\App\\bin.js'], env: {} }
	const launched = (): string => {
		const last =
			START_CMD.split('\r\n')
				.filter((l) => l.trim() !== '')
				.pop() ?? ''
		return last.replace(/^.*%NAMZU_ENGINE_ARGS%\s*/, '')
	}
	it('the task runs the launcher, and the launcher runs the runner itself, never the start command', async () => {
		// The task starts the launcher; its last line is the command the task's process becomes.
		expect(launched()).toBe('extension daemon run')
		// If the launcher asked for `daemon start` instead, that command calls ensureRunner, which with the
		// task present only runs the task again (ignored while it runs) and spawns nothing: no runner.
		let spawned = 0
		const calls: string[][] = []
		const up = await ensureRunner({
			root: '/nonexistent-root',
			engine,
			platform: 'win32',
			waitMs: 0,
			exec: async (file, args) => {
				calls.push([file, ...args])
				return 0
			},
			spawnDetached: () => {
				spawned++
				return { onExit: () => {} }
			},
		})
		expect(up).toBe(false)
		expect(spawned).toBe(0)
		expect(launched()).not.toContain('start')
	})
	it('the runner the launcher names is the same command ensureRunner starts when there is no task', async () => {
		const seen: string[][] = []
		await ensureRunner({
			root: '/nonexistent-root',
			engine,
			platform: 'win32',
			waitMs: 0,
			exec: async () => 1,
			spawnDetached: (_f, args) => {
				seen.push(args)
				return { onExit: () => {} }
			},
		})
		expect(seen[0]?.join(' ')).toContain(
			launched()
				.split(' ')
				.map((w) => `"${w}"`)
				.join(' '),
		)
	})
})
