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

const TIERS: SandboxEnvironment[] = ['basic', 'linux-namespace', 'macos-seatbelt']

function spawnFor(environment: SandboxEnvironment, limits: Record<string, number>) {
	return buildLimitedSpawn({
		environment,
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
			const spawn = spawnFor(environment, { memoryLimitMb: 128, maxProcesses: 8 })
			const rendered = [spawn.spawnCommand, ...spawn.spawnArgs].join(' ')

			expect(rendered).toContain('ulimit -v 131072')
			expect(rendered).toContain('ulimit -u 8')
		})
	}
})

describe('the tier keeps doing its own job', () => {
	it('still unshares the namespaces when a cap is set', () => {
		const spawn = spawnFor('linux-namespace', { maxProcesses: 4 })

		expect(spawn.spawnCommand).toBe('unshare')
		expect(spawn.spawnArgs.join(' ')).toContain('--pid')
	})

	it('still installs the confinement profile when a cap is set', () => {
		const spawn = spawnFor('macos-seatbelt', { maxProcesses: 4 })

		expect(spawn.spawnCommand).toBe('sandbox-exec')
		expect(spawn.spawnArgs).toContain('-p')
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
