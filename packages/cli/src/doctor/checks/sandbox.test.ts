import type { SandboxEnvironment } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { SANDBOX_ENVIRONMENTS } from '@namzu/sdk'
import { describeIsolationHealth, sandboxPlatformCheck } from './sandbox.js'

/**
 * The check used to switch on `process.platform` and answer from a table
 * written beside it, which drifted from the runtime in both directions:
 * it called the Linux probe unimplemented long after the provider began
 * probing real flags, and it told a Windows operator that sandboxing is
 * "not supported" full stop — true of the in-process tier, silent about
 * the container tier that runs there.
 *
 * The verdict is tested apart from the probe on purpose. Driving the
 * whole check can only ever exercise the outcome THIS machine produces,
 * so the branches for the other tiers would rot unnoticed — and did: an
 * earlier version of this file guarded every assertion behind the status
 * it happened to get, which made two of them unreachable here.
 */

const verdict = (environment: SandboxEnvironment) => describeIsolationHealth(environment)

describe('the verdict for a host that enforces everything', () => {
	it('passes, and names every control it is claiming', () => {
		const result = verdict('macos-seatbelt')

		expect(result.status).toBe('pass')
		expect(result.message).toBe('macos-seatbelt enforces filesystem, network, process')
	})
})

describe('the verdict for a host that enforces some of it', () => {
	it('warns rather than passing', () => {
		// The run that depended on the missing control is the one that gets
		// hurt, so a partial boundary is not a whole one.
		expect(verdict('linux-namespace').status).toBe('warn')
	})

	it('names what is missing, not just that something is', () => {
		const result = verdict('linux-namespace')

		expect(result.message).toContain('enforces network, process')
		expect(result.message).toContain('but not filesystem')
	})

	it('says what to do about it', () => {
		expect(verdict('linux-namespace').remediation).toContain('requireIsolation')
	})
})

describe('the verdict for a host that enforces nothing', () => {
	it('warns and says so plainly', () => {
		const result = verdict('basic')

		expect(result.status).toBe('warn')
		expect(result.message).toContain('enforces nothing')
		expect(result.message).toContain('unconfined')
	})

	it('points at the boundary that does work there', () => {
		// "Not supported", with nowhere to go, is what this replaced.
		expect(verdict('basic').remediation).toContain('container')
	})
})

describe('the check itself', () => {
	it('answers from the provider rather than from the OS name', async () => {
		const result = await sandboxPlatformCheck.run({} as never)

		expect(['pass', 'warn', 'fail']).toContain(result.status)
		// Derived from the SDK's own list rather than spelled out here: a
		// hand-written alternation is a copy of the tier set that nobody
		// updates, and this one broke on the first tier added after it.
		expect(result.message).toMatch(
			new RegExp(`^(${[...SANDBOX_ENVIRONMENTS, 'sandbox probe failed'].join('|')})`),
		)
	})
})
