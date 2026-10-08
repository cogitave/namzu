import childProcess from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
	buildPtyEnv,
	defaultShell,
	defaultTitle,
	descendantsOf,
	killProcessTree,
	loadHostPty,
	quietConptyHelper,
} from '../pty.js'

describe('buildPtyEnv', () => {
	it('drops the host-only variable and adds terminal ones on POSIX', () => {
		expect(buildPtyEnv({ A: '1', ELECTRON_RUN_AS_NODE: '1' }, {}, 'linux')).toEqual({
			A: '1',
			TERM: 'xterm-256color',
			COLORTERM: 'truecolor',
		})
	})

	it('lets an override win, remove, and re-add the host variable', () => {
		expect(
			buildPtyEnv(
				{ A: '1', B: '2' },
				{ A: null, ELECTRON_RUN_AS_NODE: '1', TERM: 'dumb' },
				'linux',
			),
		).toEqual({ B: '2', ELECTRON_RUN_AS_NODE: '1', TERM: 'dumb', COLORTERM: 'truecolor' })
	})

	it('matches names without regard to case on Windows, and leaves TERM alone', () => {
		expect(buildPtyEnv({ Path: 'C:\\x', ComSpec: 'cmd' }, { PATH: null }, 'win32')).toEqual({
			ComSpec: 'cmd',
		})
	})
})

describe('defaults', () => {
	it('chooses the shell the platform has', () => {
		expect(defaultShell({ SHELL: '/bin/fish' }, 'linux')).toBe('/bin/fish')
		expect(defaultShell({}, 'linux')).toBe('/bin/sh')
		expect(defaultShell({}, 'darwin')).toBe('/bin/zsh')
		expect(defaultShell({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32')).toBe(
			'C:\\Windows\\System32\\cmd.exe',
		)
		expect(defaultShell({}, 'win32')).toBe('cmd.exe')
	})

	it('titles a terminal by its program', () => {
		expect(defaultTitle('/usr/bin/bash')).toBe('bash')
		expect(defaultTitle('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh')
		expect(defaultTitle('codex.cmd')).toBe('codex')
	})
})

describe('quietConptyHelper', () => {
	function fakeFork() {
		const calls: unknown[][] = []
		const cp = {
			fork: ((...args: unknown[]) => {
				calls.push(args)
				return {} as childProcess.ChildProcess
			}) as unknown as typeof childProcess.fork,
		}
		return { cp, calls }
	}

	it('does nothing off Windows', () => {
		const { cp } = fakeFork()
		const before = cp.fork
		expect(quietConptyHelper(cp, 'linux')).toBe(false)
		expect(cp.fork).toBe(before)
	})

	it('pipes the console-list helper stderr and leaves every other fork alone', () => {
		const { cp, calls } = fakeFork()
		expect(quietConptyHelper(cp, 'win32')).toBe(true)
		cp.fork('C:\\x\\node-pty\\lib\\conpty_console_list_agent', ['123'])
		cp.fork('C:\\x\\other.js', ['1'], { cwd: 'C:\\' })
		expect(calls[0]).toEqual([
			'C:\\x\\node-pty\\lib\\conpty_console_list_agent',
			['123'],
			{ silent: true },
		])
		expect(calls[1]).toEqual(['C:\\x\\other.js', ['1'], { cwd: 'C:\\' }])
	})

	it('can patch the real module the binding requires, and be undone', () => {
		const original = childProcess.fork
		try {
			expect(quietConptyHelper(undefined, 'win32')).toBe(true)
			expect(childProcess.fork).not.toBe(original)
		} finally {
			childProcess.fork = original
		}
		expect(childProcess.fork).toBe(original)
	})

	it('is idempotent', () => {
		const { cp } = fakeFork()
		quietConptyHelper(cp, 'win32')
		const once = cp.fork
		quietConptyHelper(cp, 'win32')
		expect(cp.fork).toBe(once)
	})
})

describe.skipIf(process.platform !== 'linux')('descendantsOf', () => {
	it('finds a process the program detached from its group, below the program', async () => {
		const shell = childProcess.spawn('sh', ['-c', 'setsid sleep 300 & echo $!; wait'], {
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		try {
			const first = await new Promise<string>((done) =>
				shell.stdout.once('data', (chunk: Buffer) => done(String(chunk))),
			)
			const child = Number.parseInt(first, 10)
			expect(await descendantsOf(shell.pid as number)).toContain(child)
			expect(await descendantsOf(2 ** 22 + 12345)).toEqual([])
			process.kill(child, 'SIGKILL')
		} finally {
			shell.kill('SIGKILL')
		}
	})
})

describe('killProcessTree', () => {
	it('signals the whole group on POSIX, falling back to the program', () => {
		const kills: unknown[] = []
		// A pid that cannot be a group of ours: the group signal fails and the program is signalled.
		killProcessTree(
			{ pid: 2 ** 22 + 12345, kill: (signal) => kills.push(signal) },
			'SIGHUP',
			'linux',
		)
		expect(kills).toEqual(['SIGHUP'])
	})

	it('kills through the binding on Windows and adds the system tool only by force', () => {
		const ran: unknown[][] = []
		const kills: unknown[] = []
		const pty = { pid: 77, kill: (signal?: string) => kills.push(signal) }
		killProcessTree(pty, 'SIGTERM', 'win32', (program, args) => ran.push([program, args]))
		expect(ran).toEqual([])
		killProcessTree(pty, 'SIGKILL', 'win32', (program, args) => ran.push([program, args]))
		expect(kills).toEqual([undefined, undefined])
		expect(ran).toHaveLength(1)
		expect(ran[0]?.[1]).toEqual(['/pid', '77', '/t', '/f'])
	})
})

describe('loadHostPty', () => {
	it('names what to install when the binding is absent', async () => {
		await expect(
			loadHostPty(async () => {
				throw new Error("Cannot find module 'node-pty'")
			}),
		).rejects.toThrow(/not installed/)
	})

	it('says the binding is broken when it fails to load', async () => {
		await expect(
			loadHostPty(async () => {
				throw new Error('was compiled against a different Node.js version')
			}),
		).rejects.toThrow(/unusable/)
	})
})
