import { describe, expect, it } from 'vitest'

import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { LocalSandboxProvider } from '../provider/local.js'
import {
	PTY_SPECIFIER,
	type PtyModule,
	type PtyProcess,
	TerminalUnavailableError,
	loadPty,
	openTerminalWith,
} from '../terminal.js'

/**
 * A terminal, or a refusal that says what to install.
 *
 * `exec` runs a command and hands back what it printed, and a large class
 * of work does not fit that shape: an interactive installer waiting on a
 * prompt, a REPL, `git rebase -i`, anything that draws with escape codes.
 *
 * A pipe would APPEAR to work — bytes flow, `spawn` succeeds — and every
 * program that calls `isatty` takes its non-interactive branch. The prompt
 * never appears, the REPL exits immediately, the progress bar prints ten
 * thousand lines, and nothing says why. That is why this refuses rather
 * than substituting, which is the same rule `setNetworkPolicy` states.
 */

function fakePty(): { module: PtyModule; last: () => FakeProcess } {
	let created: FakeProcess | undefined
	return {
		module: {
			spawn(file, args, options) {
				created = new FakeProcess(file, [...args], options)
				return created
			},
		},
		last: () => {
			if (!created) throw new Error('nothing was spawned')
			return created
		},
	}
}

class FakeProcess implements PtyProcess {
	readonly written: string[] = []
	readonly resized: { cols: number; rows: number }[] = []
	killedWith: string | undefined
	private dataListeners = new Set<(d: string) => void>()
	private exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>()
	dataDisposed = false
	exitDisposed = false

	constructor(
		readonly file: string,
		readonly args: string[],
		readonly options: { name?: string; cols: number; rows: number; cwd?: string },
	) {}

	write(data: string) {
		this.written.push(data)
	}
	resize(cols: number, rows: number) {
		this.resized.push({ cols, rows })
	}
	onData(listener: (d: string) => void) {
		this.dataListeners.add(listener)
		return {
			dispose: () => {
				this.dataDisposed = true
				this.dataListeners.delete(listener)
			},
		}
	}
	onExit(listener: (e: { exitCode: number; signal?: number }) => void) {
		this.exitListeners.add(listener)
		return {
			dispose: () => {
				this.exitDisposed = true
				this.exitListeners.delete(listener)
			},
		}
	}
	kill(signal?: string) {
		this.killedWith = signal ?? 'SIGTERM'
	}
	emit(chunk: string) {
		for (const l of this.dataListeners) l(chunk)
	}
	exit(exitCode: number) {
		for (const l of [...this.exitListeners]) l({ exitCode })
	}
}

const SIZE = { cols: 120, rows: 40 }

describe('a missing binding is refused, by name', () => {
	it('says what to install', async () => {
		// A refusal that could not name the package is a refusal nobody can
		// act on.
		await expect(
			loadPty(async () => {
				throw new Error("Cannot find module 'node-pty'")
			}),
		).rejects.toThrow(new RegExp(PTY_SPECIFIER))
	})

	it('tells absent from broken, because the fixes differ', async () => {
		// `broken` is almost always a native build compiled against a
		// different Node version, and telling somebody to install a thing
		// they already installed is the least useful message available.
		const refusal = async (message: string): Promise<TerminalUnavailableError> => {
			try {
				await loadPty(async () => {
					throw new Error(message)
				})
			} catch (err) {
				return err as TerminalUnavailableError
			}
			throw new Error('expected a refusal')
		}
		const absent = await refusal("Cannot find module 'node-pty'")
		const broken = await refusal('NODE_MODULE_VERSION 108 vs 115')

		expect(absent.details.reason).toBe('absent')
		expect(absent.message).toMatch(/not installed/)
		expect(broken.details.reason).toBe('broken')
		expect(broken.message).toMatch(/native build/)
	})

	it('points at exec, and says exec is not a terminal', async () => {
		// The alternative has to be named AND its limitation stated, or the
		// caller substitutes the pipe this refusal exists to prevent.
		let err: Error | undefined
		try {
			await loadPty(async () => {
				throw new Error('Cannot find module')
			})
		} catch (caught) {
			err = caught as Error
		}
		if (!err) throw new Error('expected a refusal')

		expect(err.message).toMatch(/exec\(\)/)
		expect(err.message).toMatch(/not a terminal/)
	})

	it('refuses a module that resolved but has no spawn', async () => {
		// Something answered to the name and is not the binding. Accepting it
		// would fail later, further from the cause.
		await expect(loadPty(async () => ({}) as PtyModule)).rejects.toThrow(TerminalUnavailableError)
	})

	it('reaches a caller through the sandbox, unchanged', async () => {
		const provider = new LocalSandboxProvider(NOOP_LOGGER, {
			ptyLoader: async () => {
				throw new Error("Cannot find module 'node-pty'")
			},
		})
		const sandbox = await provider.create({})

		await expect(sandbox.openTerminal?.({ size: SIZE })).rejects.toThrow(TerminalUnavailableError)
		await sandbox.destroy()
	})
})

describe('a session that IS available', () => {
	it('declares a TERM, so a program may draw', async () => {
		// Not cosmetic: `TERM` is how a program decides which escape
		// sequences it may emit. Unset, well-behaved programs fall back to no
		// colour and no cursor movement — a terminal that works and looks
		// broken.
		const { module, last } = fakePty()
		openTerminalWith(module, { size: SIZE }, { shell: '/bin/sh', cwd: '/root' })

		expect(last().options.name).toBe('xterm-256color')
	})

	it('opens at the size it was given', async () => {
		// A program asks the terminal how big it is before it draws anything,
		// so a defaulted size produces a first frame nobody can read.
		//
		// Deliberately NOT 80x24. That is the classic terminal default, and a
		// hard-coded `cols: 80, rows: 24` in the source would pass a test
		// written with those numbers — which is exactly what happened, and
		// what the mutation caught.
		const { module, last } = fakePty()
		openTerminalWith(module, { size: { cols: 214, rows: 57 } }, { shell: '/bin/sh', cwd: '/r' })

		expect(last().options).toMatchObject({ cols: 214, rows: 57 })
	})

	it('falls back to the sandbox shell and root, not the process cwd', async () => {
		const { module, last } = fakePty()
		openTerminalWith(module, { size: SIZE }, { shell: '/bin/bash', cwd: '/sandbox/root' })

		expect(last().file).toBe('/bin/bash')
		expect(last().options.cwd).toBe('/sandbox/root')
	})

	it('runs what the caller asked for, when it asked', async () => {
		const { module, last } = fakePty()
		openTerminalWith(
			module,
			{ command: '/usr/bin/python3', args: ['-i'], cwd: '/elsewhere', size: SIZE },
			{ shell: '/bin/sh', cwd: '/root' },
		)

		expect(last().file).toBe('/usr/bin/python3')
		expect(last().args).toEqual(['-i'])
		expect(last().options.cwd).toBe('/elsewhere')
	})

	it('carries keystrokes and resizes through', async () => {
		const { module, last } = fakePty()
		const session = openTerminalWith(module, { size: SIZE }, { shell: '/bin/sh', cwd: '/r' })

		session.write('ls\r')
		session.resize({ cols: 100, rows: 30 })

		expect(last().written).toEqual(['ls\r'])
		expect(last().resized).toEqual([{ cols: 100, rows: 30 }])
	})

	it('delivers output to every listener, and stops on unsubscribe', async () => {
		const { module, last } = fakePty()
		const session = openTerminalWith(module, { size: SIZE }, { shell: '/bin/sh', cwd: '/r' })
		const a: string[] = []
		const b: string[] = []
		session.onData((c) => a.push(c))
		const off = session.onData((c) => b.push(c))

		last().emit('one')
		off()
		last().emit('two')

		expect(a).toEqual(['one', 'two'])
		expect(b).toEqual(['one'])
	})

	it('resolves when the program exits, with its code', async () => {
		const { module, last } = fakePty()
		const session = openTerminalWith(module, { size: SIZE }, { shell: '/bin/sh', cwd: '/r' })

		last().exit(3)

		expect(await session.exited).toMatchObject({ exitCode: 3 })
	})

	it('lets go of both subscriptions on exit', async () => {
		// A binding holding a listener for a dead process keeps this
		// session's closure alive for as long as the binding lives, and a
		// long-running host opens many of these.
		const { module, last } = fakePty()
		const session = openTerminalWith(module, { size: SIZE }, { shell: '/bin/sh', cwd: '/r' })
		session.onData(() => {})

		last().exit(0)
		await session.exited

		expect(last().dataDisposed).toBe(true)
		expect(last().exitDisposed).toBe(true)
	})

	it('kills with the signal it was given, and SIGTERM by default', async () => {
		const { module, last } = fakePty()
		const session = openTerminalWith(module, { size: SIZE }, { shell: '/bin/sh', cwd: '/r' })

		session.kill()
		expect(last().killedWith).toBe('SIGTERM')
		session.kill('SIGKILL')
		expect(last().killedWith).toBe('SIGKILL')
	})
})

describe('a destroyed sandbox has no terminal', () => {
	it('refuses rather than opening one in a directory that is gone', async () => {
		const { module } = fakePty()
		const provider = new LocalSandboxProvider(NOOP_LOGGER, { ptyLoader: async () => module })
		const sandbox = await provider.create({})
		await sandbox.destroy()

		await expect(sandbox.openTerminal?.({ size: SIZE })).rejects.toThrow(/destroyed/)
	})

	it('opens one for a live sandbox, rooted in it', async () => {
		const { module, last } = fakePty()
		const provider = new LocalSandboxProvider(NOOP_LOGGER, { ptyLoader: async () => module })
		const sandbox = await provider.create({})

		const session = await sandbox.openTerminal?.({ size: SIZE })

		expect(session).toBeDefined()
		expect(last().options.cwd).toBe(sandbox.rootDir)
		await sandbox.destroy()
	})
})
