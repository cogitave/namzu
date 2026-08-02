import { afterAll, describe, expect, it, vi } from 'vitest'

import type { SandboxEnvironment } from '../../types/sandbox/index.js'
import { SANDBOX_ISOLATION_CONTROLS } from '../../types/sandbox/index.js'
import { assertIsolation, describeIsolation, isolationOf, missingIsolation } from '../isolation.js'

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
		const environments: SandboxEnvironment[] = ['linux-namespace', 'macos-seatbelt', 'basic']
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
		['macos-seatbelt', 'filesystem, network, process'],
		['linux-namespace', 'network, process'],
		['basic', 'nothing'],
	] as const)('%s enforces %s', (environment, expected) => {
		expect(describeIsolation(environment)).toBe(expected)
	})
})

describe('the provider', () => {
	// `process.platform` is a per-worker global, and vitest reuses workers
	// across files — leaving it patched would make an unrelated file's
	// platform check answer for this one.
	const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

	afterAll(() => {
		if (realPlatform) Object.defineProperty(process, 'platform', realPlatform)
		vi.doUnmock('node:child_process')
		vi.resetModules()
	})

	async function providerWith(environment: SandboxEnvironment) {
		vi.resetModules()
		vi.doMock('node:child_process', async () => {
			const actual =
				await vi.importActual<typeof import('node:child_process')>('node:child_process')
			return {
				...actual,
				execSync: (command: string) => {
					const wanted = environment === 'linux-namespace' ? 'unshare' : 'sandbox-exec'
					if (environment !== 'basic' && command.startsWith(wanted)) return Buffer.alloc(0)
					throw new Error('not available')
				},
			}
		})
		Object.defineProperty(process, 'platform', {
			value: environment === 'macos-seatbelt' ? 'darwin' : 'linux',
			configurable: true,
		})
		return await import('../provider/local.js')
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
})
