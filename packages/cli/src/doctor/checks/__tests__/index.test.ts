/**
 * The registry-shape acceptance for NZ-BOOT-02: every optional capability
 * named in `NAMZU_OPTIONAL_CAPABILITIES` has exactly one doctor check
 * registered for it, and the tri-state probe those checks share reports
 * status honestly enough that an all-absent machine still exits `0` while a
 * broken one does not — `an-optional-dependency-may-not-degrade-a-check`,
 * asserted at the level the doctor's exit code actually lives at.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { NAMZU_OPTIONAL_CAPABILITIES, capabilityCheckId } from '../../../context/capabilities.js'
import { createDoctorRegistry, runDoctor } from '../../registry.js'
import {
	builtInDoctorChecks,
	computerUseInstalledCheck,
	filesInstalledCheck,
	sandboxInstalledCheck,
	telemetryInstalledCheck,
} from '../index.js'
import { describeInstalledPackage } from '../telemetry.js'

describe('every optional capability has exactly one registered check', () => {
	it('builtInDoctorChecks carries an id for every entry in NAMZU_OPTIONAL_CAPABILITIES', () => {
		// Computed from the SAME rule the checks themselves are built with, so
		// this fails the build the moment a capability is added to the constant
		// and nobody wires up its check — the gap this extraction exists to close.
		const expectedIds = new Set(NAMZU_OPTIONAL_CAPABILITIES.map(capabilityCheckId))
		const registeredIds = new Set(builtInDoctorChecks.map((check) => check.id))

		for (const id of expectedIds) {
			expect(registeredIds.has(id), `no doctor check registered for id "${id}"`).toBe(true)
		}
	})

	it('names each of the three new checks, so a rename here is caught alongside the set', () => {
		expect(sandboxInstalledCheck.id).toBe(capabilityCheckId('@namzu/sandbox'))
		expect(filesInstalledCheck.id).toBe(capabilityCheckId('@namzu/files'))
		expect(computerUseInstalledCheck.id).toBe(capabilityCheckId('@namzu/computer-use'))
		expect(telemetryInstalledCheck.id).toBe(capabilityCheckId('@namzu/telemetry'))
	})
})

describe('an optional capability never gates readiness, a broken one always fails it', () => {
	let root: string

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'namzu-capability-doctor-'))
	})

	afterEach(() => {
		removeTempDir(root)
	})

	it('an all-absent optional-capability run stays exit 0', async () => {
		const reg = createDoctorRegistry()
		reg.register({
			id: 'fixture.absent',
			category: 'custom',
			run: () => describeInstalledPackage('@namzu/no-such-package-nz-boot-02'),
		})

		const report = await runDoctor({ registry: reg })

		expect(report.checks[0]?.status).toBe('skipped')
		expect(report.exit).toBe(0)
	})

	it('a broken optional capability fails the doctor run, not skips it', async () => {
		const file = join(root, 'broken.mjs')
		writeFileSync(file, "throw new Error('DOCTOR FIXTURE BROKEN')\n")
		const reg = createDoctorRegistry()
		reg.register({
			id: 'fixture.broken',
			category: 'custom',
			run: () => describeInstalledPackage(file),
		})

		const report = await runDoctor({ registry: reg })

		expect(report.checks[0]?.status).toBe('fail')
		expect(report.checks[0]?.message ?? '').toContain('DOCTOR FIXTURE BROKEN')
		expect(report.exit).toBe(1)
	})
})
