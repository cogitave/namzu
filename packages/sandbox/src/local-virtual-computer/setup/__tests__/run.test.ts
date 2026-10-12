import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
	RunElevatedWslcSteps,
	WslcSetupConsent,
	WslcSetupOptions,
	WslcSetupProgress,
} from '../contract.js'

vi.mock('../wsl-package.js', () => ({
	PINNED_WSL_PACKAGE: {
		version: '3.0.1.0',
		architecture: 'x64',
		url: 'https://github.com/microsoft/WSL/releases/download/3.0.1/wsl.3.0.1.0.x64.msi',
		sha256: 'e'.repeat(64),
		sizeBytes: 367_000_000,
	},
	downloadWslPackage: vi.fn(),
}))
vi.mock('../resume.js', () => ({
	registerResumeAtSignIn: vi.fn(async () => {}),
	clearResumeAtSignIn: vi.fn(async () => {}),
}))
vi.mock('../elevated.js', () => ({ runElevatedWslcSteps: vi.fn() }))

import { runElevatedWslcSteps } from '../elevated.js'
import { planWslcSetup } from '../plan.js'
import { inspectWslcReadiness } from '../readiness.js'
import { readRestartMarker, writeRestartMarker } from '../restart.js'
import { clearResumeAtSignIn, registerResumeAtSignIn } from '../resume.js'
import { runWslcSetup } from '../run.js'
import { downloadWslPackage } from '../wsl-package.js'
import { readManifest } from '../wslc-shared.js'
import {
	type FakeRunner,
	IMAGE_ID,
	IMAGE_REF,
	WSL_ENGLISH,
	failure,
	fakeHost,
	inspectJson,
	tempDirectory,
	windowsRunner,
	writeBundle,
} from './fakes.js'

const CONTENT = Buffer.from('an archive')
const SHA = createHash('sha256').update(CONTENT).digest('hex')
const NOT_FOUND = failure(1, ['WSLC_E_IMAGE_NOT_FOUND'])

let directory: string
let manifestPath: string
let archivePath: string
beforeEach(async () => {
	vi.clearAllMocks()
	directory = await tempDirectory()
	const bundle = await writeBundle(directory, CONTENT, SHA)
	manifestPath = bundle.manifestPath
	archivePath = bundle.archivePath
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

/** A runner whose image appears once `load` has run, like the real engine. */
function engine(extra: Parameters<typeof windowsRunner>[0] = {}): FakeRunner {
	const runner = windowsRunner(extra)
	let loaded = false
	runner.set('wslc image inspect -f json namzu-local-computer:2', () =>
		loaded ? inspectJson(IMAGE_ID) : NOT_FOUND,
	)
	runner.set(`wslc load -q -i ${archivePath}`, () => {
		loaded = true
		return ''
	})
	return runner
}

function options(
	runner: FakeRunner,
	more: Partial<WslcSetupOptions> = {},
	policy?: { AllowWSL?: number; AllowWSLContainer?: number },
) {
	return {
		imageRef: IMAGE_REF,
		bundledManifestPath: manifestPath,
		host: fakeHost({ stateDirectory: directory, runner, policy }),
		wslPackage: {
			version: '3.0.1.0',
			architecture: 'x64' as const,
			url: 'https://github.com/microsoft/WSL/releases/download/3.0.1/wsl.3.0.1.0.x64.msi',
			sha256: 'e'.repeat(64),
			sizeBytes: 367_000_000,
		},
		...more,
	}
}

/** The consent a person gives to the plan they were shown (a probing inspection). */
async function consentTo(o: ReturnType<typeof options>): Promise<WslcSetupConsent> {
	const readiness = await inspectWslcReadiness({ ...o, probeSession: true })
	const plan = planWslcSetup(readiness, {
		wslPackage: o.wslPackage,
		manifest: readiness.image.bundled ? await readManifest(manifestPath) : undefined,
	})
	return { planId: plan.id, approvedAt: '2026-10-12T12:00:00.000Z' }
}

const elevated = vi.mocked(runElevatedWslcSteps)
const download = vi.mocked(downloadWslPackage)

describe('runWslcSetup: only the image is missing', () => {
	it('loads it without any elevated call and ends ready', async () => {
		const runner = engine()
		const o = options(runner)
		const progress: WslcSetupProgress[] = []
		const standIn = vi.fn<RunElevatedWslcSteps>()
		const result = await runWslcSetup(await consentTo(o), {
			...o,
			onProgress: (p) => progress.push(p),
			runElevated: standIn,
		})
		expect(result).toEqual({ outcome: 'ready' })
		expect(standIn).not.toHaveBeenCalled()
		expect(download).not.toHaveBeenCalled()
		expect(progress[0]).toEqual({ step: 'load-image', phase: 'started' })
		expect(progress.at(-1)).toEqual({ step: 'load-image', phase: 'finished', result: 'ok' })
		expect(progress.filter((p) => p.phase === 'started')).toHaveLength(1)
		expect(runner.calls.at(-1)).toBe('wslc image inspect -f json namzu-local-computer:2')
	})

	it('is ready at once, with no steps, when the image is already loaded', async () => {
		const runner = windowsRunner({ imageInspect: inspectJson(IMAGE_ID) })
		const o = options(runner)
		const result = await runWslcSetup(await consentTo(o), o)
		expect(result).toEqual({ outcome: 'ready' })
		expect(runner.calls.some((c) => c.startsWith('wslc load'))).toBe(false)
	})
})

describe('runWslcSetup: consent', () => {
	it('refuses a consent for a plan that is gone and hands back the new one', async () => {
		const runner = engine()
		const o = options(runner)
		const stale = await consentTo(o)
		runner.set('wslc image inspect -f json namzu-local-computer:2', inspectJson(IMAGE_ID))
		const result = await runWslcSetup(stale, o)
		expect(result).toMatchObject({ outcome: 'plan-changed', plan: { steps: [] } })
		expect(runner.calls.some((c) => c.startsWith('wslc load'))).toBe(false)
	})

	it('refuses an invented plan id before touching anything', async () => {
		const runner = engine()
		const result = await runWslcSetup({ planId: 'nope', approvedAt: 'now' }, options(runner))
		expect(result.outcome).toBe('plan-changed')
		expect(runner.calls.some((c) => c.startsWith('wslc load'))).toBe(false)
		expect(elevated).not.toHaveBeenCalled()
	})

	it('reports a blocked plan as blocked, never as a failure', async () => {
		const runner = engine()
		const o = options(runner, {}, { AllowWSLContainer: 0 })
		const result = await runWslcSetup(await consentTo(o), o)
		expect(result).toEqual({ outcome: 'blocked', blocked: 'blocked-by-policy' })
	})
})

describe('runWslcSetup: WSL is missing', () => {
	function missing(): FakeRunner {
		const runner = engine({ wsl: null, wslc: null })
		elevated.mockImplementation(async (request) => {
			// The install worked: WSL now answers.
			runner.set('wsl --version', WSL_ENGLISH)
			runner.set('wslc version', 'wslc 3.0.1.0\r\n')
			request.onProgress?.({ step: 'install-wsl', phase: 'started' })
			request.onProgress?.({
				step: 'install-wsl',
				phase: 'progress',
				done: 50,
				total: 100,
				unit: 'percent',
			})
			return { outcome: 'ok' }
		})
		download.mockImplementation(async (request) => {
			request.onProgress?.({
				step: 'download-wsl',
				phase: 'progress',
				done: 1,
				total: 2,
				unit: 'bytes',
			})
			return { outcome: 'ok', path: `${request.directory}/wsl.msi` }
		})
		return runner
	}

	it('downloads, installs in one elevated call, loads the image and ends ready', async () => {
		const runner = missing()
		const o = options(runner)
		const progress: WslcSetupProgress[] = []
		const result = await runWslcSetup(await consentTo(o), {
			...o,
			onProgress: (p) => progress.push(p),
		})
		expect(result).toEqual({ outcome: 'ready' })
		expect(download).toHaveBeenCalledTimes(1)
		expect(download.mock.calls[0]?.[0]).toMatchObject({ directory })
		expect(elevated).toHaveBeenCalledTimes(1)
		expect(elevated.mock.calls[0]?.[0]).toMatchObject({
			steps: ['install-wsl'],
			wslPackage: { path: `${directory}/wsl.msi`, sha256: 'e'.repeat(64) },
		})
		expect(progress.map((p) => `${p.step}:${p.phase}`)).toEqual([
			'download-wsl:started',
			'download-wsl:progress',
			'download-wsl:finished',
			'install-wsl:started',
			'install-wsl:progress',
			'install-wsl:finished',
			'load-image:started',
			'load-image:progress',
			'load-image:finished',
		])
	})

	it('uses the stand-in elevated runner when given one', async () => {
		const runner = missing()
		const o = options(runner)
		const standIn = vi.fn<RunElevatedWslcSteps>(async () => {
			runner.set('wsl --version', WSL_ENGLISH)
			runner.set('wslc version', 'wslc 3.0.1.0\r\n')
			return { outcome: 'ok' }
		})
		const result = await runWslcSetup(await consentTo(o), { ...o, runElevated: standIn })
		expect(result).toEqual({ outcome: 'ready' })
		expect(standIn).toHaveBeenCalledTimes(1)
		expect(elevated).not.toHaveBeenCalled()
	})

	it('stops on a failed download and names the step', async () => {
		const runner = missing()
		download.mockResolvedValue({ outcome: 'failed', code: 'download-failed', detail: 'offline' })
		const o = options(runner)
		const result = await runWslcSetup(await consentTo(o), o)
		expect(result).toEqual({
			outcome: 'failed',
			step: 'download-wsl',
			code: 'download-failed',
			detail: 'offline',
		})
		expect(elevated).not.toHaveBeenCalled()
	})

	it.each([
		['cancelled', { outcome: 'cancelled' }, { outcome: 'cancelled' }],
		['needs-administrator', { outcome: 'needs-administrator' }, { outcome: 'needs-administrator' }],
		[
			'failed with a code',
			{ outcome: 'failed', step: 'install-wsl', code: 'wsl-install-failed', exitCode: 1603 },
			{
				outcome: 'failed',
				step: 'install-wsl',
				code: 'wsl-install-failed',
				detail: 'Windows could not finish this step (error 1603).',
			},
		],
		[
			'failed without a code',
			{ outcome: 'failed', step: 'install-wsl', code: 'elevation-failed' },
			{
				outcome: 'failed',
				step: 'install-wsl',
				code: 'elevation-failed',
				detail: 'Windows could not finish this step.',
			},
		],
	] as const)('maps an elevated outcome of %s', async (_label, outcome, expected) => {
		const runner = missing()
		elevated.mockResolvedValue(outcome)
		const o = options(runner)
		const result = await runWslcSetup(await consentTo(o), o)
		expect(result).toEqual(expected)
		expect(runner.calls.some((c) => c.startsWith('wslc load'))).toBe(false)
		expect(await readRestartMarker({ stateDirectory: directory } as never)).toBeUndefined()
	})

	it('records the restart, registers the resume command and stops', async () => {
		const runner = missing()
		elevated.mockResolvedValue({ outcome: 'restart-required' })
		const o = options(runner)
		const progress: WslcSetupProgress[] = []
		const result = await runWslcSetup(await consentTo(o), {
			...o,
			resumeCommand: '"C:\\Namzu\\namzu.exe" computer setup --resume',
			onProgress: (p) => progress.push(p),
		})
		expect(result).toEqual({ outcome: 'restart-required' })
		const marker = await readRestartMarker({ stateDirectory: directory } as never)
		expect(marker).toEqual({
			recordedAt: '2026-10-12T12:00:00.000Z',
			planId: expect.stringMatching(/^[0-9a-f]{64}$/),
			remaining: ['load-image'],
		})
		expect(registerResumeAtSignIn).toHaveBeenCalledTimes(1)
		expect(vi.mocked(registerResumeAtSignIn).mock.calls[0]?.[1]).toBe(
			'"C:\\Namzu\\namzu.exe" computer setup --resume',
		)
		expect(progress.at(-1)).toEqual({
			step: 'install-wsl',
			phase: 'finished',
			result: 'restart-required',
		})
		expect(runner.calls.some((c) => c.startsWith('wslc load'))).toBe(false)
	})

	it('registers no resume command when the caller gave none', async () => {
		const runner = missing()
		elevated.mockResolvedValue({ outcome: 'restart-required' })
		const o = options(runner)
		await runWslcSetup(await consentTo(o), o)
		expect(registerResumeAtSignIn).not.toHaveBeenCalled()
	})
})

describe('runWslcSetup: features and a restart', () => {
	it('records every step after the elevated ones as remaining', async () => {
		const runner = engine({ vmp: false })
		elevated.mockResolvedValue({ outcome: 'restart-required' })
		const o = options(runner)
		const result = await runWslcSetup(await consentTo(o), o)
		expect(result).toEqual({ outcome: 'restart-required' })
		expect(elevated.mock.calls[0]?.[0].steps).toEqual(['enable-windows-features'])
		expect((await readRestartMarker({ stateDirectory: directory } as never))?.remaining).toEqual([
			'load-image',
		])
	})

	it('does not wait for a restart Windows said it does not need', async () => {
		const runner = engine({ vmp: false })
		elevated.mockImplementation(async () => {
			runner.set('sc query HNS', 'SERVICE_NAME: HNS')
			runner.set('sc query vmcompute', 'SERVICE_NAME: vmcompute')
			return { outcome: 'ok' }
		})
		const o = options(runner)
		const result = await runWslcSetup(await consentTo(o), o)
		expect(result).toEqual({ outcome: 'ready' })
	})
})

describe('runWslcSetup: a restart is already pending', () => {
	it('answers restart-required and changes nothing', async () => {
		const runner = engine()
		await writeRestartMarker({ stateDirectory: directory } as never, {
			recordedAt: '2026-10-12T09:00:00.000Z',
			planId: 'x',
			remaining: ['load-image'],
		})
		const o = options(runner)
		const result = await runWslcSetup(await consentTo(o), o)
		expect(result).toEqual({ outcome: 'restart-required' })
		expect(runner.calls.some((c) => c.startsWith('wslc load'))).toBe(false)
	})

	it('after the restart, continues, clears the marker and takes back the resume entry', async () => {
		const runner = engine()
		await writeRestartMarker({ stateDirectory: directory } as never, {
			recordedAt: '2026-10-12T06:00:00.000Z',
			planId: 'x',
			remaining: ['load-image'],
		})
		// Windows booted at 08:00, after the marker was written at 06:00.
		const o = options(runner)
		const consent = await consentTo(o)
		// The panel's own inspection cleared the marker; put it back as a crash would.
		await writeRestartMarker({ stateDirectory: directory } as never, {
			recordedAt: '2026-10-12T06:00:00.000Z',
			planId: 'x',
			remaining: ['load-image'],
		})
		const result = await runWslcSetup(consent, o)
		expect(result).toEqual({ outcome: 'ready' })
		expect(await readRestartMarker({ stateDirectory: directory } as never)).toBeUndefined()
		expect(clearResumeAtSignIn).toHaveBeenCalledTimes(1)
	})
})

describe('runWslcSetup: the image step fails', () => {
	it('returns the image failure with its code', async () => {
		const runner = engine()
		runner.set(`wslc load -q -i ${archivePath}`, failure(1))
		const o = options(runner)
		const result = await runWslcSetup(await consentTo(o), o)
		expect(result).toMatchObject({
			outcome: 'failed',
			step: 'load-image',
			code: 'image-load-failed',
		})
	})

	it('fails as engine-failed when setup finished but the PC is still not ready', async () => {
		const runner = engine()
		// The load works, then wslc stops answering before the final inspection.
		runner.set(`wslc load -q -i ${archivePath}`, () => {
			runner.set('wslc version', failure(1))
			runner.set('wsl --version', failure(1))
			runner.set('wslc image inspect -f json namzu-local-computer:2', inspectJson(IMAGE_ID))
			return ''
		})
		const o = options(runner)
		const result = await runWslcSetup(await consentTo(o), o)
		expect(result).toMatchObject({ outcome: 'failed', step: 'load-image', code: 'engine-failed' })
	})

	it('reports virtualization trouble found at the end as blocked', async () => {
		const runner = engine()
		let loaded = false
		runner.set(`wslc load -q -i ${archivePath}`, () => {
			loaded = true
			return ''
		})
		runner.set('wslc image inspect -f json namzu-local-computer:2', () =>
			loaded ? inspectJson(IMAGE_ID) : NOT_FOUND,
		)
		runner.set(
			'powershell -NoProfile -NonInteractive -Command (Get-CimInstance Win32_ComputerSystem).HypervisorPresent',
			() => (loaded ? 'False' : 'True'),
		)
		const o = options(runner)
		const result = await runWslcSetup(await consentTo(o), o)
		expect(result).toEqual({ outcome: 'blocked', blocked: 'virtualization-off' })
	})
})
