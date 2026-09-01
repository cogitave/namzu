import { describe, expect, it } from 'vitest'

import type { SandboxEnvironment } from '../../types/sandbox/index.js'
import { buildLimitedSpawn } from '../provider/local.js'

/**
 * `memoryLimitMb` and `maxProcesses` were applied on one tier and dropped on
 * the other two — and the two that dropped them are the STRONGER ones. A
 * host that asked for isolation got its blast-radius caps silently removed
 * by choosing better isolation, which is the worst direction for a control
 * to fail in.
 *
 * The sibling backend in the sandbox package already treats this as an
 * error rather than a default: unenforceable per-sandbox controls are
 * refused there, not ignored. Here they are enforceable on every tier —
 * the mechanism is a shell builtin, and each tier already spawns through
 * a wrapper it can sit inside — so they are enforced.
 */

const TIERS: SandboxEnvironment[] = ['basic', 'linux-bwrap', 'linux-namespace', 'macos-seatbelt']

const WRAPPER = {
	'linux-bwrap': '/trusted/bin/bwrap',
	'linux-namespace': '/trusted/bin/unshare',
	'macos-seatbelt': '/trusted/bin/sandbox-exec',
} as const

function spawnFor(environment: SandboxEnvironment, limits: Record<string, number>) {
	return buildLimitedSpawn({
		environment,
		...(environment === 'basic' ? {} : { wrapperCommand: WRAPPER[environment] }),
		command: 'node',
		args: ['-e', "console.log('hi')"],
		rootDir: '/tmp/sandbox-root',
		...limits,
	})
}

describe('a resource cap survives the choice of tier', () => {
	for (const environment of TIERS) {
		it(`applies a memory cap under ${environment}`, () => {
			const spawn = spawnFor(environment, { memoryLimitMb: 256 })
			const rendered = [spawn.spawnCommand, ...spawn.spawnArgs].join(' ')

			expect(rendered).toContain('ulimit -v 262144')
		})

		it(`applies a process cap under ${environment}`, () => {
			const spawn = spawnFor(environment, { maxProcesses: 32 })
			const rendered = [spawn.spawnCommand, ...spawn.spawnArgs].join(' ')

			expect(rendered).toContain('ulimit -u 32')
		})

		it(`applies both together under ${environment}`, () => {
			const spawn = spawnFor(environment, {
				memoryLimitMb: 128,
				maxProcesses: 8,
			})
			const rendered = [spawn.spawnCommand, ...spawn.spawnArgs].join(' ')

			expect(rendered).toContain('ulimit -v 131072')
			expect(rendered).toContain('ulimit -u 8')
		})
	}
})

describe('the tier keeps doing its own job', () => {
	it('still unshares the namespaces when a cap is set', () => {
		const spawn = spawnFor('linux-namespace', { maxProcesses: 4 })

		expect(spawn.spawnCommand).toBe('/trusted/bin/unshare')
		expect(spawn.spawnArgs.join(' ')).toContain('--pid')
	})

	it('still installs the confinement profile when a cap is set', () => {
		const spawn = spawnFor('macos-seatbelt', { maxProcesses: 4 })

		expect(spawn.spawnCommand).toBe('/trusted/bin/sandbox-exec')
		expect(spawn.spawnArgs).toContain('-p')
	})

	it('passes an adversarial workspace path as data instead of SBPL source', () => {
		const rootDir = '/tmp/workspace")\n(allow file-read* (subpath "/"))'
		const spawn = buildLimitedSpawn({
			environment: 'macos-seatbelt',
			wrapperCommand: WRAPPER['macos-seatbelt'],
			command: 'node',
			args: [],
			rootDir,
		})
		const profile = spawn.spawnArgs[spawn.spawnArgs.indexOf('-p') + 1]

		expect(profile).toContain('(subpath (param "NAMZU_SANDBOX_ROOT"))')
		expect(profile).not.toContain(rootDir)
		expect(spawn.spawnArgs).toContain(`-DNAMZU_SANDBOX_ROOT=/private${rootDir}`)
	})

	it('pins the probed wrapper instead of resolving it through the command environment', () => {
		const spawn = spawnFor('linux-bwrap', {})

		expect(spawn.spawnCommand).toBe('/trusted/bin/bwrap')
		expect(spawn.spawnCommand).not.toBe('bwrap')
	})

	it('refuses an isolated tier with no probed absolute wrapper', () => {
		expect(() =>
			buildLimitedSpawn({
				environment: 'linux-namespace',
				command: 'node',
				args: [],
				rootDir: '/tmp/sandbox-root',
			}),
		).toThrow(/requires the absolute wrapper path that was probed/)
	})
})

describe('nothing is wrapped when nothing was capped', () => {
	it('spawns the command directly under the unconfined tier', () => {
		const spawn = spawnFor('basic', {})

		expect(spawn.spawnCommand).toBe('node')
		expect(spawn.spawnArgs).toEqual(['-e', "console.log('hi')"])
	})

	it('leaves the wrapper alone under the stronger tiers', () => {
		const spawn = spawnFor('linux-namespace', {})

		expect(spawn.spawnArgs).toContain('node')
		expect(spawn.spawnArgs.join(' ')).not.toContain('ulimit')
	})
})

describe('an argument cannot break out of the shell that applies the cap', () => {
	it('quotes a single quote in an argument', () => {
		const spawn = buildLimitedSpawn({
			environment: 'basic',
			command: 'echo',
			args: ["it's; rm -rf /"],
			rootDir: '/tmp/sandbox-root',
			maxProcesses: 4,
		})
		const rendered = spawn.spawnArgs.join(' ')

		// The payload survives as ONE argument rather than becoming a second
		// command: the `;` stays inside the quoting.
		expect(rendered).not.toContain("; rm -rf / '")
		expect(rendered).toContain("'\\''")
	})
})
