/**
 * The tri-state probe, exercised directly rather than through a doctor
 * check — this is the extraction `doctor/checks/telemetry.ts` used to keep
 * to itself. The acceptance bar is that every one of the three states is
 * reachable through the REAL resolver and the REAL loader, not a stub.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	NAMZU_OPTIONAL_CAPABILITIES,
	capabilityCheckId,
	probeCapabilities,
	probeOptionalPackage,
} from '../capabilities.js'

let root: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-capability-'))
})

afterEach(() => {
	removeTempDir(root)
})

/** A trivial ESM module with a real package.json next to it, at `version`. */
function presentFixture(version: string): string {
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version }))
	const file = join(root, 'index.mjs')
	writeFileSync(file, 'export {}\n')
	return file
}

/** A module that resolves and then throws the moment it is evaluated. */
function throwingFixture(message: string): string {
	const file = join(root, 'broken.mjs')
	writeFileSync(file, `throw new Error(${JSON.stringify(message)})\n`)
	return file
}

/** A module whose own top-level import cannot resolve — the module itself is not missing. */
function transitiveFailureFixture(): string {
	const file = join(root, 'transitive.mjs')
	writeFileSync(file, "import 'nz-boot-02-nonexistent-transitive-dependency'\n")
	return file
}

describe('probeOptionalPackage — the three states', () => {
	it('reports absent for a specifier that does not resolve', async () => {
		const probe = await probeOptionalPackage('@namzu/no-such-package-nz-boot-02')
		expect(probe.state).toBe('absent')
	})

	it('reports present, with the version read off the nearest package.json, when the module resolves and loads', async () => {
		const entry = presentFixture('9.9.9')

		const probe = await probeOptionalPackage(entry)

		expect(probe.state).toBe('present')
		if (probe.state !== 'present') throw new Error('unreachable')
		expect(probe.version).toBe('9.9.9')
	})

	it('walks up multiple directory levels to find the manifest, for an entry nested inside dist/', async () => {
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ name: 'fixture-nested', version: '3.4.5' }),
		)
		const nestedDir = join(root, 'dist', 'nested')
		mkdirSync(nestedDir, { recursive: true })
		const entry = join(nestedDir, 'index.mjs')
		writeFileSync(entry, 'export {}\n')

		const probe = await probeOptionalPackage(entry)

		expect(probe.state).toBe('present')
		if (probe.state !== 'present') throw new Error('unreachable')
		expect(probe.version).toBe('3.4.5')
	})

	it('reports broken — not absent — when a resolvable module throws on evaluation', async () => {
		const probe = await probeOptionalPackage(throwingFixture('boom'))

		expect(probe.state).toBe('broken')
		if (probe.state !== 'broken') throw new Error('unreachable')
		expect(probe.error.message).toBe('boom')
	})

	it('reports broken — not absent — when the module resolves but its OWN import does not', async () => {
		// The case the header calls out by name: `ERR_MODULE_NOT_FOUND` from a
		// transitive dependency is identical to the code a genuinely missing
		// package raises. Collapsing this into `absent` is the exact bug the
		// resolve-then-import split exists to prevent, and it is the assertion
		// that fails if the probe is ever reimplemented as a code check on the
		// thrown error.
		const probe = await probeOptionalPackage(transitiveFailureFixture())

		expect(probe.state).toBe('broken')
	})
})

describe('probeCapabilities — never throws', () => {
	it('resolves with one record per specifier, even with all three states represented', async () => {
		// `probeCapabilities()` itself only probes the fixed
		// NAMZU_OPTIONAL_CAPABILITIES list, which on a dev/CI machine with none
		// of the four installed reports four `absent` records and proves
		// nothing about the broken path. This drives the exact composition
		// `probeCapabilities` uses — `Promise.all` over `probeOptionalPackage`
		// — with one specifier in each of the three states, which is the
		// combination that would reject if `probeOptionalPackage` ever let an
		// error escape instead of turning it into a `broken` record.
		const specifiers = [
			presentFixture('1.0.0'),
			'@namzu/no-such-package-nz-boot-02',
			throwingFixture('boom'),
		]

		const probes = await Promise.all(specifiers.map((specifier) => probeOptionalPackage(specifier)))

		expect(probes).toHaveLength(3)
		expect(probes.map((p) => p.state).sort()).toEqual(['absent', 'broken', 'present'])
	})

	it('probes the real NAMZU_OPTIONAL_CAPABILITIES list without rejecting', async () => {
		const probes = await probeCapabilities()

		expect(probes).toHaveLength(NAMZU_OPTIONAL_CAPABILITIES.length)
		for (const probe of probes) {
			expect(['present', 'absent', 'broken']).toContain(probe.state)
		}
	})
})

describe('capabilityCheckId', () => {
	it('derives one id per NAMZU_OPTIONAL_CAPABILITIES entry, with no collisions', () => {
		const ids = NAMZU_OPTIONAL_CAPABILITIES.map(capabilityCheckId)

		expect(ids).toEqual([
			'sandbox.installed',
			'files.installed',
			'computer-use.installed',
			'telemetry.installed',
		])
		expect(new Set(ids).size).toBe(ids.length)
	})
})

describe('an ESM-only package that IS installed', () => {
	/**
	 * The regression this file did not have, and the one that made every
	 * fixture-driven test above pass against a probe that was wrong in
	 * production.
	 *
	 * Every test above drives an absolute FIXTURE PATH, because there is no
	 * way to uninstall a real package inside a test run. None of them touches
	 * the branch that resolves a bare specifier — and that branch used
	 * `require.resolve`, which throws `ERR_PACKAGE_PATH_NOT_EXPORTED` for a
	 * package whose `exports` map declares `import` without `default`. Every
	 * optional package here is exactly that shape, so `@namzu/files` and
	 * `@namzu/telemetry` were reported "not installed (optional package)" on
	 * machines where both were installed and working, and `namzu doctor` said
	 * so out loud.
	 *
	 * `@namzu/sdk` is what hid it: its exports map carries a `default`
	 * condition, so it was the one specifier that resolved, and anyone
	 * spot-checking the probe against it saw the right answer.
	 */
	it('reports present, not absent', async () => {
		const probe = await probeOptionalPackage('@namzu/files')

		expect(probe.state).toBe('present')
		if (probe.state === 'present') expect(probe.version).toMatch(/^\d+\./)
	})

	it('still reports absent for a specifier that really is not there', async () => {
		// The other direction, so the test above cannot be satisfied by a probe
		// that answers `present` unconditionally.
		const probe = await probeOptionalPackage('@namzu/definitely-not-a-real-package')

		expect(probe.state).toBe('absent')
	})
})
