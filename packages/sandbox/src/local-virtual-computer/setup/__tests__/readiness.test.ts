import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WslcReadinessState } from '../contract.js'
import { inspectWslcReadiness, parseWslVersion } from '../readiness.js'
import { clearRestartMarker, readRestartMarker, writeRestartMarker } from '../restart.js'
import { writeImageRecord } from '../wslc-shared.js'
import {
	IMAGE_ID,
	IMAGE_REF,
	type Scenario,
	WSL_ENGLISH,
	WSL_TURKISH,
	failure,
	fakeHost,
	inspectJson,
	tempDirectory,
	utf16,
	windowsRunner,
	writeBundle,
} from './fakes.js'

let directory: string
beforeEach(async () => {
	directory = await tempDirectory()
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

async function inspect(
	scenario: Scenario,
	extra: {
		build?: number
		platform?: NodeJS.Platform
		arch?: string
		probe?: boolean
		bootTime?: Date
		manifestPath?: string
	} = {},
) {
	const runner = windowsRunner(scenario)
	const readiness = await inspectWslcReadiness({
		imageRef: IMAGE_REF,
		probeSession: extra.probe,
		bundledManifestPath: extra.manifestPath,
		host: fakeHost({
			stateDirectory: directory,
			runner,
			windowsBuild: extra.build,
			platform: extra.platform,
			arch: extra.arch,
			policy: scenario.policy,
			bootTime: extra.bootTime,
		}),
	})
	return { readiness, runner }
}

describe('parseWslVersion', () => {
	it('reads the first x.y.z.w of the first line, whatever the language', () => {
		expect(parseWslVersion(WSL_ENGLISH)).toBe('3.0.1.0')
		expect(parseWslVersion(WSL_TURKISH)).toBe('3.0.1.0')
		expect(parseWslVersion('\uFEFFWSL version: 2.9.3.0\r\nKernel version: 6.6.1.1\r\n')).toBe(
			'2.9.3.0',
		)
		expect(parseWslVersion('\r\n\r\nWSL: 2.1.5.0\r\n')).toBe('2.1.5.0')
	})
	it('finds nothing in a help text or an empty answer', () => {
		expect(parseWslVersion('')).toBeUndefined()
		expect(
			parseWslVersion(utf16('Copyright (c) Microsoft Corporation.\r\nUsage: wsl.exe\r\n')),
		).toBeUndefined()
	})
})

describe('inspectWslcReadiness without probe', () => {
	const matrix: [string, Scenario, WslcReadinessState][] = [
		['policy blocks WSL', { policy: { AllowWSL: 0 } }, 'blocked-by-policy'],
		['policy blocks containers', { policy: { AllowWSLContainer: 0 } }, 'blocked-by-policy'],
		['Virtual Machine Platform is off', { vmp: false }, 'platform-off'],
		['the Windows 10 component is off', { lxss: false }, 'platform-off'],
		['no WSL package answers', { wsl: null, wslc: null }, 'wsl-missing'],
		['WSL answers but wslc is missing', { wslc: null }, 'wsl-outdated'],
		['wslc is below the floor', { wslc: 'wslc 2.8.9.0\r\n' }, 'wsl-outdated'],
		['no hypervisor runs with the platform on', { hypervisor: 'False' }, 'virtualization-off'],
		['wslc works and nothing is recorded', {}, 'image-missing'],
	]
	it.each(matrix)('says %s', async (_label, scenario, state) => {
		const { readiness } = await inspect(scenario)
		expect(readiness.state).toBe(state)
	})

	it('takes the first state that applies: policy before platform before wsl', async () => {
		const { readiness } = await inspect({
			policy: { AllowWSL: 0 },
			vmp: false,
			wsl: null,
			wslc: null,
		})
		expect(readiness.state).toBe('blocked-by-policy')
		expect(readiness.policy).toEqual({ allowWsl: false, allowWslContainer: true })
		const second = await inspect({ vmp: false, wsl: null, wslc: null })
		expect(second.readiness.state).toBe('platform-off')
	})

	it('reports facts even for a state that hides them', async () => {
		const { readiness } = await inspect({ vmp: false, wsl: null, wslc: null })
		expect(readiness.components.virtualMachinePlatform).toBe(false)
		expect(readiness.wsl).toEqual({})
		expect(readiness.windows).toEqual({ build: 19045, architecture: 'x64', isWindows11: false })
	})

	it('reads the versions from localised UTF-16 and CRLF output', async () => {
		const { readiness } = await inspect({ wsl: WSL_TURKISH })
		expect(readiness.wsl).toEqual({
			version: '3.0.1.0',
			wslcBinary: 'C:\\Program Files\\WSL\\wslc.exe',
			wslcVersion: '3.0.1',
		})
	})

	it('does not need the Windows 10 component on Windows 11', async () => {
		const { readiness, runner } = await inspect({ lxss: false }, { build: 26100 })
		expect(readiness.components.wslOptionalComponent).toBe('not-needed')
		expect(readiness.windows?.isWindows11).toBe(true)
		expect(readiness.state).toBe('image-missing')
		expect(runner.calls).not.toContain('sc query LxssManager')
	})

	it('treats an unreadable hypervisor answer as unknown, not as off', async () => {
		const { readiness } = await inspect({ hypervisor: 'garbage' })
		expect(readiness.components.hypervisorPresent).toBe('unknown')
		expect(readiness.state).toBe('image-missing')
	})

	it('treats a service query that fails for another reason as unknown', async () => {
		const runner = windowsRunner()
		runner.set('sc query HNS', failure(5))
		const readiness = await inspectWslcReadiness({
			imageRef: IMAGE_REF,
			host: fakeHost({ stateDirectory: directory, runner }),
		})
		expect(readiness.components.virtualMachinePlatform).toBe('unknown')
		expect(readiness.state).toBe('image-missing')
	})

	it('never runs a command that starts the wslc session', async () => {
		const { runner } = await inspect({})
		expect(runner.calls.filter((call) => /^wslc (?!version)/.test(call))).toEqual([])
	})

	it('takes image.loaded from the record setup wrote', async () => {
		await writeImageRecord(
			{ stateDirectory: directory },
			{ imageRef: IMAGE_REF, imageId: IMAGE_ID, loadedAt: '2026-10-12T00:00:00.000Z' },
		)
		const { readiness } = await inspect({})
		expect(readiness.state).toBe('ready')
		expect(readiness.image).toEqual({ ref: IMAGE_REF, loaded: true })
	})

	it('ignores a record for another image', async () => {
		await writeImageRecord(
			{ stateDirectory: directory },
			{
				imageRef: 'namzu-local-computer:1',
				imageId: IMAGE_ID,
				loadedAt: '2026-10-12T00:00:00.000Z',
			},
		)
		const { readiness } = await inspect({})
		expect(readiness.state).toBe('image-missing')
	})

	it('ignores a record whose image differs from the bundled manifest', async () => {
		const bundle = await writeBundle(directory, Buffer.from('x'), 'f'.repeat(64))
		await writeImageRecord(
			{ stateDirectory: directory },
			{
				imageRef: IMAGE_REF,
				imageId: `sha256:${'b'.repeat(64)}`,
				loadedAt: '2026-10-12T00:00:00.000Z',
			},
		)
		const { readiness } = await inspect({}, { manifestPath: bundle.manifestPath })
		expect(readiness.state).toBe('image-missing')
		expect(readiness.image.bundled).toEqual({
			manifestPath: bundle.manifestPath,
			archivePath: bundle.archivePath,
		})
	})

	it('offers no bundled image when the archive is missing or the manifest is invalid', async () => {
		const bundle = await writeBundle(directory, Buffer.from('x'), 'f'.repeat(64))
		await rm(bundle.archivePath)
		expect(
			(await inspect({}, { manifestPath: bundle.manifestPath })).readiness.image.bundled,
		).toBeUndefined()
		expect(
			(await inspect({}, { manifestPath: `${directory}/nope.json` })).readiness.image.bundled,
		).toBeUndefined()
	})
})

describe('unsupported machines', () => {
	it.each([
		['platform', { platform: 'linux' as const }],
		['architecture', { arch: 'arm64' }],
		['windows-build', { build: 18363 }],
	])('names %s and runs nothing', async (reason, extra) => {
		const { readiness, runner } = await inspect({}, extra)
		expect(readiness.state).toBe('unsupported')
		expect(readiness.unsupportedReason).toBe(reason)
		expect(runner.calls).toEqual([])
	})
})

describe('inspectWslcReadiness with probe', () => {
	it('is ready when the engine reports the bundled image id', async () => {
		const bundle = await writeBundle(directory, Buffer.from('x'), 'f'.repeat(64))
		const { readiness } = await inspect(
			{ imageInspect: inspectJson(IMAGE_ID) },
			{ probe: true, manifestPath: bundle.manifestPath },
		)
		expect(readiness.state).toBe('ready')
		expect(readiness.image.loaded).toBe(true)
	})

	it('does not believe a record: an image the engine lacks is missing', async () => {
		await writeImageRecord(
			{ stateDirectory: directory },
			{ imageRef: IMAGE_REF, imageId: IMAGE_ID, loadedAt: '2026-10-12T00:00:00.000Z' },
		)
		const { readiness } = await inspect({}, { probe: true })
		expect(readiness.state).toBe('image-missing')
		expect(readiness.image.loaded).toBe(false)
	})

	it('treats another image id under the same reference as not loaded', async () => {
		const bundle = await writeBundle(directory, Buffer.from('x'), 'f'.repeat(64))
		const { readiness } = await inspect(
			{ imageInspect: inspectJson(`sha256:${'c'.repeat(64)}`) },
			{ probe: true, manifestPath: bundle.manifestPath },
		)
		expect(readiness.state).toBe('image-missing')
	})

	it.each([
		['0x80370102', 'virtualization-off'],
		['0x8004060C', 'blocked-by-policy'],
		['0x8004060B', 'sdk-mismatch'],
	] as const)('maps %s to %s', async (code, state) => {
		const { readiness } = await inspect({ imageInspect: failure(1, [code]) }, { probe: true })
		expect(readiness.state).toBe(state)
	})

	it('does not probe a machine that failed an earlier check', async () => {
		const { readiness, runner } = await inspect({ vmp: false }, { probe: true })
		expect(readiness.state).toBe('platform-off')
		expect(runner.calls.some((call) => call.startsWith('wslc image'))).toBe(false)
	})
})

describe('the restart marker', () => {
	const recordedAt = '2026-10-12T09:00:00.000Z'
	const marker = { recordedAt, planId: 'p', remaining: ['load-image' as const] }

	it('holds the state at restart-pending while the PC has not restarted', async () => {
		await writeRestartMarker({ stateDirectory: directory } as never, marker)
		const { readiness } = await inspect({}, { bootTime: new Date('2026-10-12T08:00:00.000Z') })
		expect(readiness.state).toBe('restart-pending')
		expect(readiness.restart).toEqual({
			recordedAt,
			bootTime: '2026-10-12T08:00:00.000Z',
		})
		expect(await readRestartMarker({ stateDirectory: directory } as never)).toEqual(marker)
	})

	it('clears the marker once the boot time is later than it', async () => {
		await writeRestartMarker({ stateDirectory: directory } as never, marker)
		const { readiness } = await inspect({}, { bootTime: new Date('2026-10-12T09:00:01.000Z') })
		expect(readiness.state).toBe('image-missing')
		expect(readiness.restart).toBeUndefined()
		expect(await readRestartMarker({ stateDirectory: directory } as never)).toBeUndefined()
	})

	it('keeps policy ahead of a pending restart', async () => {
		await writeRestartMarker({ stateDirectory: directory } as never, marker)
		const { readiness } = await inspect({ policy: { AllowWSLContainer: 0 } })
		expect(readiness.state).toBe('blocked-by-policy')
		await clearRestartMarker({ stateDirectory: directory } as never)
	})
})
