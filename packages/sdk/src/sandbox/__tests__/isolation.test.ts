import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it, vi } from 'vitest'

import type { SandboxEnvironment } from '../../types/sandbox/index.js'
import { SANDBOX_ISOLATION_CONTROLS } from '../../types/sandbox/index.js'
import { assertIsolation, describeIsolation, isolationOf, missingIsolation } from '../isolation.js'
import { acceptsSandboxSpawnProbe } from '../provider/local.js'

/**
 * The provider reported `id = 'local'` / `name = 'Local Sandbox'` at every
 * tier, and construction logged at `info` regardless. A host that turned
 * isolation on deliberately got a tier-dependent amount of it under one
 * undifferentiated name, with no signal saying which controls were live.
 *
 * These tests pin the honest table and the refusal. What must NOT hold is
 * as important as what must: the tier that unshares a mount namespace
 * without remounting anything does not confine the filesystem, and saying
 * it does here would reintroduce exactly the defect being fixed.
 */

describe('what each tier actually enforces', () => {
	it('reports full enforcement only where a deny-default profile is installed', () => {
		expect(isolationOf('macos-seatbelt')).toEqual({
			filesystem: true,
			network: true,
			process: true,
		})
		expect(isolationOf('linux-bwrap')).toEqual({
			filesystem: true,
			network: true,
			process: true,
		})
	})

	it('does not claim filesystem confinement from an unshared mount namespace', () => {
		// A private mount table is not confinement: nothing is remounted, so
		// the child still sees the whole host filesystem.
		expect(isolationOf('linux-namespace').filesystem).toBe(false)
		expect(isolationOf('linux-namespace').process).toBe(true)
	})

	it('claims nothing at all for the unconfined tier', () => {
		const report = isolationOf('basic')
		expect(Object.values(report)).toEqual([false, false, false])
	})

	it('covers every environment the type admits', () => {
		const environments: SandboxEnvironment[] = [
			'linux-bwrap',
			'linux-namespace',
			'macos-seatbelt',
			'basic',
		]
		for (const environment of environments) {
			const report = isolationOf(environment)
			for (const control of SANDBOX_ISOLATION_CONTROLS) {
				expect(typeof report[control]).toBe('boolean')
			}
		}
	})
})

describe('requiring a control', () => {
	it('lets through what the tier can enforce', () => {
		expect(() => assertIsolation('macos-seatbelt', ['filesystem', 'network'])).not.toThrow()
		expect(() => assertIsolation('linux-namespace', ['network', 'process'])).not.toThrow()
	})

	it('refuses rather than downgrading', () => {
		expect(() => assertIsolation('linux-namespace', ['filesystem'])).toThrow(
			/cannot enforce filesystem/,
		)
		expect(() => assertIsolation('basic', ['network'])).toThrow(/cannot enforce network/)
	})

	it('says what it does enforce, so the refusal is actionable', () => {
		expect(() => assertIsolation('linux-namespace', ['filesystem'])).toThrow(
			/Enforced here: network, process/,
		)
		expect(() => assertIsolation('basic', ['process'])).toThrow(/Enforced here: nothing/)
	})

	it('names every missing control, not just the first', () => {
		expect(missingIsolation('basic', ['filesystem', 'network', 'process'])).toEqual([
			'filesystem',
			'network',
			'process',
		])
	})

	it('requires nothing by default, so best-effort callers are unaffected', () => {
		expect(() => assertIsolation('basic', [])).not.toThrow()
	})
})

describe('describing a tier', () => {
	it.each([
		['linux-bwrap', 'filesystem, network, process'],
		['macos-seatbelt', 'filesystem, network, process'],
		['linux-namespace', 'network, process'],
		['basic', 'nothing'],
	] as const)('%s enforces %s', (environment, expected) => {
		expect(describeIsolation(environment)).toBe(expected)
	})
})

describe('a tier probe observes the production spawn boundary', () => {
	it('accepts only an exact successful sentinel round trip', () => {
		expect(
			acceptsSandboxSpawnProbe({
				status: 0,
				signal: null,
				stdout: 'namzu-sandbox-spawn-probe',
			}),
		).toBe(true)
	})

	it.each([
		{
			name: 'spawn error despite a child exit',
			observation: {
				error: new Error('direct spawn refused'),
				status: 0,
				signal: null,
				stdout: 'namzu-sandbox-spawn-probe',
			},
		},
		{
			name: 'non-zero exit',
			observation: { status: 1, signal: null, stdout: 'namzu-sandbox-spawn-probe' },
		},
		{
			name: 'terminating signal',
			observation: { status: 0, signal: 'SIGTERM' as const, stdout: '' },
		},
		{
			name: 'stdout pipe that lost the sentinel',
			observation: { status: 0, signal: null, stdout: '' },
		},
	])('refuses a $name', ({ observation }) => {
		expect(acceptsSandboxSpawnProbe(observation)).toBe(false)
	})
})

describe('the provider', () => {
	// `process.platform` is a per-worker global, and vitest reuses workers
	// across files — leaving it patched would make an unrelated file's
	// platform check answer for this one.
	const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
	let spawnedCommands: string[] = []
	let spawnedEnvironments: Record<string, string>[] = []
	let probedInnerCommands: string[] = []

	afterAll(() => {
		if (realPlatform) Object.defineProperty(process, 'platform', realPlatform)
		vi.doUnmock('node:child_process')
		vi.doUnmock('node:fs')
		vi.resetModules()
	})

	async function providerWith(
		environment: SandboxEnvironment,
		platform: NodeJS.Platform = environment === 'macos-seatbelt' ? 'darwin' : 'linux',
	) {
		vi.resetModules()
		spawnedCommands = []
		spawnedEnvironments = []
		probedInnerCommands = []
		const wanted =
			environment === 'linux-bwrap'
				? 'bwrap'
				: environment === 'linux-namespace'
					? 'unshare'
					: 'sandbox-exec'
		vi.doMock('node:fs', async () => {
			const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
			return {
				...actual,
				accessSync: (candidate: string) => {
					if (environment !== 'basic' && candidate.endsWith(`/${wanted}`)) return
					throw new Error('not available')
				},
				realpathSync: (candidate: string) => candidate,
			}
		})
		vi.doMock('node:child_process', async () => {
			const actual =
				await vi.importActual<typeof import('node:child_process')>('node:child_process')
			return {
				...actual,
				spawn: (
					command: string,
					_args: readonly string[],
					options?: { readonly env?: Record<string, string> },
				) => {
					spawnedCommands.push(command)
					spawnedEnvironments.push({ ...(options?.env ?? {}) })
					const child = new EventEmitter() as EventEmitter & {
						pid: number
						stdout: PassThrough
						stderr: PassThrough
						stdio: PassThrough[]
					}
					child.pid = 42
					child.stdout = new PassThrough()
					child.stderr = new PassThrough()
					child.stdio = [
						new PassThrough(),
						child.stdout,
						child.stderr,
						new PassThrough(),
						new PassThrough(),
					]
					queueMicrotask(() => {
						if (environment === 'linux-bwrap') {
							child.stdio[3]?.write('{ "child-pid": 43 }\n')
						}
						child.stdout.end()
						child.stderr.end()
						child.emit('close', 0, null)
					})
					return child
				},
				spawnSync: (command: string, args: readonly string[]) => {
					const separator = args.indexOf('--')
					probedInnerCommands.push(args[separator + 1] ?? '')
					if (environment !== 'basic' && command.endsWith(`/${wanted}`)) {
						return {
							status: 0,
							signal: null,
							stdout: 'namzu-sandbox-spawn-probe',
							...(environment === 'linux-bwrap'
								? {
									output: [null, 'namzu-sandbox-spawn-probe', '', '{ "child-pid": 43 }\n', null],
									}
								: {}),
						}
					}
					return {
						error: new Error('not available'),
						status: null,
						signal: null,
						stdout: null,
					}
				},
			}
		})
		Object.defineProperty(process, 'platform', { value: platform, configurable: true })
		return await import('../provider/local.js')
	}

	function preserveEnv(names: readonly string[]): () => void {
		const previous = new Map(names.map((name) => [name, process.env[name]]))
		return () => {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name]
				else process.env[name] = value
			}
		}
	}

	const logger = () => {
		const calls: Array<{ level: string; message: string }> = []
		const log = {
			calls,
			child: () => log,
			debug: () => {},
			info: (message: string) => calls.push({ level: 'info', message }),
			warn: (message: string) => calls.push({ level: 'warn', message }),
			error: () => {},
		}
		return log
	}

	it('warns, not informs, when it confines nothing', async () => {
		const { LocalSandboxProvider } = await providerWith('basic')
		const log = logger()
		new LocalSandboxProvider(log as never)

		// `info` here reads as "sandbox created" to anyone scanning a log.
		expect(log.calls.some((c) => c.level === 'warn' && /unconfined/.test(c.message))).toBe(true)
		expect(log.calls.some((c) => c.level === 'info')).toBe(false)
	})

	it('throws at construction when a required control is unavailable', async () => {
		const { LocalSandboxProvider } = await providerWith('basic')
		expect(
			() => new LocalSandboxProvider(logger() as never, { requireIsolation: ['filesystem'] }),
		).toThrow(/cannot enforce filesystem/)
	})

	it('constructs when the tier supplies what was asked for', async () => {
		const { LocalSandboxProvider } = await providerWith('macos-seatbelt')
		const provider = new LocalSandboxProvider(logger() as never, {
			requireIsolation: ['filesystem', 'network'],
		})
		expect(provider.environment).toBe('macos-seatbelt')
	})

	it('keeps the exact probed Linux wrapper behind the selected tier', async () => {
		const { LocalSandboxProvider } = await providerWith('linux-bwrap')
		const provider = new LocalSandboxProvider(logger() as never, {
			requireIsolation: ['filesystem', 'network', 'process'],
		})
		expect(provider.environment).toBe('linux-bwrap')
		expect((provider as unknown as { wrapperCommand: string }).wrapperCommand).toBe(
			'/usr/bin/bwrap',
		)
		expect(probedInnerCommands).toEqual([process.execPath])

		const sandbox = await provider.create({ env: { PATH: '/tmp/fake-wrapper-bin' } })
		try {
			expect((sandbox as unknown as { wrapperCommand: string }).wrapperCommand).toBe(
				'/usr/bin/bwrap',
			)
			await sandbox.exec('node', ['-e', '0'], {
				env: { PATH: '/tmp/second-fake-wrapper-bin' },
			})
			expect(spawnedCommands).toEqual(['/usr/bin/bwrap'])
		} finally {
			await sandbox.destroy()
		}
	})

	it('hands a Windows child its startup plumbing with one explicit PATH winner', async () => {
		const names = ['WinDir', 'SystemRoot', 'ComSpec', 'Path', 'NAMZU_TEST_SANDBOX_SECRET']
		const restoreEnv = preserveEnv(names)
		process.env.WinDir = 'C:\\Windows'
		process.env.SystemRoot = 'C:\\Windows'
		process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
		process.env.Path = 'C:\\ambient'
		process.env.NAMZU_TEST_SANDBOX_SECRET = 'must-not-travel'

		try {
			const { LocalSandboxProvider } = await providerWith('basic', 'win32')
			const sandbox = await new LocalSandboxProvider(logger() as never).create({
				env: { Path: 'C:\\configured' },
			})
			try {
				await sandbox.exec('cmd.exe', ['/c', 'exit 0'], {
					env: { PATH: 'C:\\per-call' },
				})
				const env = spawnedEnvironments.at(-1)
				expect(env).toMatchObject({
					WinDir: 'C:\\Windows',
					SystemRoot: 'C:\\Windows',
					ComSpec: 'C:\\Windows\\System32\\cmd.exe',
					PATH: 'C:\\per-call',
				})
				expect(Object.keys(env ?? {}).filter((key) => key.toUpperCase() === 'PATH')).toEqual([
					'PATH',
				])
				expect(env).not.toHaveProperty('NAMZU_TEST_SANDBOX_SECRET')
			} finally {
				await sandbox.destroy()
			}
		} finally {
			restoreEnv()
		}
	})

	it('does not widen the Linux sandbox with Windows-only ambient names', async () => {
		const names = ['TERM', 'APPDATA', 'WINDIR']
		const restoreEnv = preserveEnv(names)
		process.env.TERM = 'xterm-test'
		process.env.APPDATA = 'credential-sentinel'
		process.env.WINDIR = 'windows-sentinel'

		try {
			const { LocalSandboxProvider } = await providerWith('basic', 'linux')
			const sandbox = await new LocalSandboxProvider(logger() as never).create()
			try {
				await sandbox.exec('node', ['-e', '0'])
				const env = spawnedEnvironments.at(-1)
				expect(env?.TERM).toBe('xterm-test')
				expect(env).not.toHaveProperty('APPDATA')
				expect(env).not.toHaveProperty('WINDIR')
			} finally {
				await sandbox.destroy()
			}
		} finally {
			restoreEnv()
		}
	})
})
