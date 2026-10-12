import { describe, expect, it } from 'vitest'
import type { PinnedWslPackage, WslcReadiness, WslcReadinessState } from '../contract.js'
import { planWslcSetup } from '../plan.js'
import { IMAGE_REF, MANIFEST } from './fakes.js'

const PACKAGE: PinnedWslPackage = {
	version: '3.0.1.0',
	architecture: 'x64',
	url: 'https://github.com/microsoft/WSL/releases/download/3.0.1/wsl.3.0.1.0.x64.msi',
	sha256: 'e'.repeat(64),
	sizeBytes: 367_000_000,
}

function readiness(state: WslcReadinessState, patch: Partial<WslcReadiness> = {}): WslcReadiness {
	return {
		state,
		policy: { allowWsl: true, allowWslContainer: true },
		components: {
			virtualMachinePlatform: true,
			wslOptionalComponent: true,
			hypervisorPresent: true,
		},
		wsl: { version: '3.0.1.0', wslcBinary: 'wslc.exe', wslcVersion: '3.0.1' },
		image: {
			ref: IMAGE_REF,
			loaded: false,
			bundled: { manifestPath: 'm.json', archivePath: 'a.zst' },
		},
		checkedAt: '2026-10-12T12:00:00.000Z',
		...patch,
	}
}

const OPTIONS = { wslPackage: PACKAGE, manifest: MANIFEST }
const kinds = (r: WslcReadiness, options = OPTIONS) =>
	planWslcSetup(r, options).steps.map((step) => step.kind)

describe('planWslcSetup', () => {
	it('has nothing to do when ready', () => {
		const plan = planWslcSetup(
			readiness('ready', { image: { ref: IMAGE_REF, loaded: true } }),
			OPTIONS,
		)
		expect(plan.steps).toEqual([])
		expect(plan.elevationPrompts).toBe(0)
		expect(plan.mayRequireRestart).toBe(false)
		expect(plan.blocked).toBeUndefined()
	})

	it('only loads the image when wslc already works', () => {
		const plan = planWslcSetup(readiness('image-missing'), OPTIONS)
		expect(plan.steps).toEqual([
			{
				kind: 'load-image',
				elevated: false,
				diskBytes: MANIFEST.sizeBytes,
				estimatedSeconds: expect.any(Number),
				mayRequireRestart: false,
			},
		])
		expect(plan.elevationPrompts).toBe(0)
		expect(plan.mayRequireRestart).toBe(false)
	})

	it('downloads, installs and loads when WSL is missing', () => {
		const r = readiness('wsl-missing', { wsl: {} })
		const plan = planWslcSetup(r, OPTIONS)
		expect(plan.steps.map((s) => s.kind)).toEqual(['download-wsl', 'install-wsl', 'load-image'])
		const [download, install] = plan.steps
		expect(download).toMatchObject({ elevated: false, downloadBytes: 367_000_000 })
		expect(download?.estimatedSeconds).toBeGreaterThan(0)
		expect(install).toMatchObject({ elevated: true, mayRequireRestart: true })
		expect(plan.elevationPrompts).toBe(1)
		expect(plan.mayRequireRestart).toBe(true)
	})

	it('treats an outdated WSL like a missing one', () => {
		const r = readiness('wsl-outdated', { wsl: { version: '2.1.5.0', wslcVersion: '2.8.0' } })
		expect(kinds(r)).toEqual(['download-wsl', 'install-wsl', 'load-image'])
	})

	it('enables features, installs, then restarts before loading the image', () => {
		const r = readiness('platform-off', {
			wsl: {},
			components: {
				virtualMachinePlatform: false,
				wslOptionalComponent: false,
				hypervisorPresent: false,
			},
		})
		const plan = planWslcSetup(r, OPTIONS)
		expect(plan.steps.map((s) => s.kind)).toEqual([
			'download-wsl',
			'enable-windows-features',
			'install-wsl',
			'restart',
			'load-image',
		])
		expect(plan.elevationPrompts).toBe(1)
	})

	it('derives steps from the facts, not only the headline state', () => {
		// The headline says platform-off, but WSL is current: no download or install.
		const r = readiness('platform-off', {
			components: {
				virtualMachinePlatform: false,
				wslOptionalComponent: 'not-needed',
				hypervisorPresent: 'unknown',
			},
		})
		expect(kinds(r)).toEqual(['enable-windows-features', 'restart', 'load-image'])
	})

	it('needs no enable step when only the Windows 11 component is "not-needed"', () => {
		const r = readiness('wsl-missing', {
			wsl: {},
			components: {
				virtualMachinePlatform: true,
				wslOptionalComponent: 'not-needed',
				hypervisorPresent: true,
			},
		})
		expect(kinds(r)).toEqual(['download-wsl', 'install-wsl', 'load-image'])
	})

	it('skips the image when it is already loaded', () => {
		const r = readiness('wsl-outdated', {
			wsl: { version: '2.1.5.0' },
			image: { ref: IMAGE_REF, loaded: true },
		})
		expect(kinds(r)).toEqual(['download-wsl', 'install-wsl'])
	})

	it('is blocked as image-unavailable when no image can be had', () => {
		const r = readiness('image-missing', { image: { ref: IMAGE_REF, loaded: false } })
		const plan = planWslcSetup(r, { wslPackage: PACKAGE })
		expect(plan.blocked).toBe('image-unavailable')
		expect(plan.steps).toEqual([])
		expect(plan.elevationPrompts).toBe(0)
	})

	it('is blocked as image-unavailable even when WSL is also missing', () => {
		const r = readiness('wsl-missing', { wsl: {}, image: { ref: IMAGE_REF, loaded: false } })
		expect(planWslcSetup(r, { wslPackage: PACKAGE }).blocked).toBe('image-unavailable')
	})

	it.each([
		['unsupported', 'unsupported'],
		['blocked-by-policy', 'blocked-by-policy'],
		['virtualization-off', 'virtualization-off'],
		['sdk-mismatch', 'sdk-mismatch'],
	] as const)('blocks %s with no steps', (state, blocked) => {
		const plan = planWslcSetup(readiness(state, { wsl: {} }), OPTIONS)
		expect(plan).toMatchObject({ state, blocked, steps: [], elevationPrompts: 0 })
	})

	it('puts the restart first when one is pending, then what remains', () => {
		const plan = planWslcSetup(readiness('restart-pending'), OPTIONS)
		expect(plan.steps.map((s) => s.kind)).toEqual(['restart', 'load-image'])
		expect(plan.mayRequireRestart).toBe(true)
		expect(plan.elevationPrompts).toBe(0)
		const loaded = planWslcSetup(
			readiness('restart-pending', { image: { ref: IMAGE_REF, loaded: true } }),
			OPTIONS,
		)
		expect(loaded.steps.map((s) => s.kind)).toEqual(['restart'])
	})

	describe('id', () => {
		it('is stable across inspections and ignores the inspection time', () => {
			const a = planWslcSetup(readiness('image-missing'), OPTIONS)
			const b = planWslcSetup(
				readiness('image-missing', { checkedAt: '2027-01-01T00:00:00.000Z' }),
				OPTIONS,
			)
			expect(a.id).toMatch(/^[0-9a-f]{64}$/)
			expect(a.id).toBe(b.id)
		})
		it('changes with the state, the steps, the pinned package and the manifest', () => {
			const base = planWslcSetup(readiness('wsl-missing', { wsl: {} }), OPTIONS).id
			expect(planWslcSetup(readiness('wsl-outdated', { wsl: {} }), OPTIONS).id).not.toBe(base)
			expect(
				planWslcSetup(
					readiness('wsl-missing', { wsl: {}, image: { ref: IMAGE_REF, loaded: true } }),
					OPTIONS,
				).id,
			).not.toBe(base)
			expect(
				planWslcSetup(readiness('wsl-missing', { wsl: {} }), {
					...OPTIONS,
					wslPackage: { ...PACKAGE, version: '3.0.2.0' },
				}).id,
			).not.toBe(base)
			expect(
				planWslcSetup(readiness('wsl-missing', { wsl: {} }), {
					...OPTIONS,
					manifest: { ...MANIFEST, sha256: '9'.repeat(64) },
				}).id,
			).not.toBe(base)
		})
	})
})
