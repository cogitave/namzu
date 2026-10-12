import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalCommandError, LocalComputerSetupError } from '../../engine.js'
import { createWslcSetupHost, windowsArchitectureOf } from '../host.js'
import { loadWslcImage } from '../image.js'
import { PROBE_LIMIT_MS, ProbeTimeoutError, runLimited } from '../limits.js'
import { planWslcSetup } from '../plan.js'
import { inspectWslcReadiness } from '../readiness.js'
import { wslcBinaryOf } from '../wslc-shared.js'
import {
	type FakeRunner,
	IMAGE_ID,
	IMAGE_REF,
	MANIFEST,
	type Scenario,
	failure,
	fakeHost,
	fakeRunner,
	inspectJson,
	tempDirectory,
	windowsRunner,
	writeBundle,
} from './fakes.js'

const HYPERVISOR =
	'powershell -NoProfile -NonInteractive -Command (Get-CimInstance Win32_ComputerSystem).HypervisorPresent'
const REBOOT_PENDING =
	'reg query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'
const REBOOT_REQUIRED =
	'reg query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
const INSPECT = 'wslc image inspect -f json namzu-local-computer:2'

let directory: string
beforeEach(async () => {
	directory = await tempDirectory()
})
afterEach(async () => {
	vi.useRealTimers()
	await rm(directory, { recursive: true, force: true })
})

function keyOf(binary: string, args: readonly string[]): string {
	const name = /([^\\/]+?)(?:\.exe)?$/i.exec(binary)?.[1] ?? binary
	return [name, ...args].join(' ')
}

/**
 * A runner that never answers the listed commands until its signal aborts,
 * and says when each one was started. Other commands go to `base`.
 */
function hanging(base: FakeRunner, keys: readonly string[]) {
	const started = new Map<string, Promise<void>>()
	const signals = new Map<string, AbortSignal | undefined>()
	const resolvers = new Map<string, () => void>()
	for (const key of keys)
		started.set(
			key,
			new Promise<void>((resolve) => {
				resolvers.set(key, resolve)
			}),
		)
	const runner: FakeRunner = {
		calls: base.calls,
		set: base.set,
		run(binary, args, options) {
			const key = keyOf(binary, args)
			if (!keys.includes(key)) return base.run(binary, args, options)
			base.calls.push(key)
			signals.set(key, options?.signal)
			resolvers.get(key)?.()
			return new Promise<string>((_, reject) => {
				options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
					once: true,
				})
			})
		},
	}
	return { runner, started, signals }
}

async function inspectWith(
	runner: FakeRunner,
	extra: { probe?: boolean; bootTime?: () => Promise<Date>; signal?: AbortSignal } = {},
) {
	return inspectWslcReadiness({
		imageRef: IMAGE_REF,
		probeSession: extra.probe,
		signal: extra.signal,
		host: {
			...fakeHost({ stateDirectory: directory, runner }),
			...(extra.bootTime ? { bootTime: extra.bootTime } : {}),
		},
	})
}

describe('every probe has its own time limit', () => {
	it('runLimited stops waiting, aborts the runner signal, and lets the caller signal win', async () => {
		vi.useFakeTimers()
		let seen: AbortSignal | undefined
		const never = {
			run: (_b: string, _a: readonly string[], o?: { signal?: AbortSignal }) => {
				seen = o?.signal
				return new Promise<string>(() => {})
			},
		}
		const pending = runLimited(never, 'x', [], 1000).catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(999)
		expect(seen?.aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(await pending).toBeInstanceOf(ProbeTimeoutError)
		expect(seen?.aborted).toBe(true)

		const outer = new AbortController()
		const cancelled = runLimited(never, 'x', [], 1000, { signal: outer.signal }).catch(
			(error: unknown) => error,
		)
		outer.abort(new Error('stop'))
		expect(await cancelled).toMatchObject({ message: 'stop' })
	})

	it('degrades hung service, PowerShell and wsl.exe checks to unknown facts', async () => {
		vi.useFakeTimers()
		const keys = ['sc query HNS', 'sc query vmcompute', 'sc query LxssManager', HYPERVISOR]
		const { runner, started } = hanging(windowsRunner({ wsl: null }), [...keys, 'wsl --version'])
		const pending = inspectWith(runner)
		await started.get(HYPERVISOR)
		await vi.advanceTimersByTimeAsync(PROBE_LIMIT_MS.command - 1)
		let settled = false
		void pending.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(PROBE_LIMIT_MS.powershell)
		const readiness = await pending
		expect(readiness.components).toEqual({
			virtualMachinePlatform: 'unknown',
			wslOptionalComponent: 'unknown',
			hypervisorPresent: 'unknown',
		})
		expect(readiness.wsl.version).toBeUndefined()
		expect(readiness.state).toBe('image-missing')
	})

	it('cannot decide the state when wslc itself does not answer, and says so plainly', async () => {
		vi.useFakeTimers()
		const { runner, started } = hanging(windowsRunner(), ['wslc version'])
		const pending = inspectWith(runner).catch((error: unknown) => error)
		await started.get('wslc version')
		await vi.advanceTimersByTimeAsync(PROBE_LIMIT_MS.command)
		const error = await pending
		expect(error).toBeInstanceOf(LocalComputerSetupError)
		expect((error as Error).message).toBe(
			'Linux container support did not answer, so Namzu could not check this PC. Try again in a moment.',
		)
	})

	it('gives the command that starts the session 60 seconds, then cannot decide', async () => {
		vi.useFakeTimers()
		const { runner, started, signals } = hanging(windowsRunner(), [INSPECT])
		const pending = inspectWith(runner, { probe: true }).catch((error: unknown) => error)
		await started.get(INSPECT)
		await vi.advanceTimersByTimeAsync(PROBE_LIMIT_MS.session - 1)
		expect(signals.get(INSPECT)?.aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(signals.get(INSPECT)?.aborted).toBe(true)
		expect(await pending).toBeInstanceOf(LocalComputerSetupError)
	})

	it('limits the real host: a registry read is unset, a key unknown, a boot time an error', async () => {
		vi.useFakeTimers()
		const never = { run: () => new Promise<string>(() => {}) }
		const host = createWslcSetupHost({ runner: never, platform: 'win32', env: {} })
		const dword = host.readDword('HKLM\\x', 'y')
		const key = host.keyExists('HKLM\\x')
		const boot = host.bootTime().catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(PROBE_LIMIT_MS.command)
		expect(await dword).toBeUndefined()
		expect(await key).toBe('unknown')
		await vi.advanceTimersByTimeAsync(PROBE_LIMIT_MS.powershell - PROBE_LIMIT_MS.command)
		expect(await boot).toBeInstanceOf(ProbeTimeoutError)
	})
})

describe('a restart marker that cannot be trusted', () => {
	const marker = {
		recordedAt: '2026-10-12T09:00:00.000Z',
		planId: 'p',
		remaining: ['load-image'],
	}

	it('stays restart-pending when the boot time cannot be read', async () => {
		await mkdir(directory, { recursive: true })
		await writeFile(join(directory, 'restart.json'), JSON.stringify(marker))
		const readiness = await inspectWith(windowsRunner(), {
			bootTime: async () => {
				throw new Error('no boot time')
			},
		})
		expect(readiness.state).toBe('restart-pending')
		expect(readiness.restart).toEqual({ recordedAt: marker.recordedAt })
	})

	it('ends an unreadable marker with the next boot, by the file date', async () => {
		// A directory where the file should be: reading it fails with EISDIR.
		await mkdir(join(directory, 'restart.json'), { recursive: true })
		const pending = await inspectWith(windowsRunner(), { bootTime: async () => new Date(0) })
		expect(pending.state).toBe('restart-pending')
		expect(pending.restart?.recordedAt).not.toBe(pending.checkedAt)
		// The same unreadable marker, seen after the PC restarted, no longer holds.
		const later = await inspectWith(windowsRunner(), {
			bootTime: async () => new Date(Date.now() + 60_000),
		})
		expect(later.state).toBe('image-missing')
		expect(later.restart).toBeUndefined()
	})

	it('cannot decide when the marker can neither be read nor dated, and says where it is', async () => {
		// A path with a NUL byte fails every file call with something other than ENOENT.
		const stateDirectory = `${directory}\0x`
		const error = await inspectWslcReadiness({
			imageRef: IMAGE_REF,
			host: fakeHost({ stateDirectory, runner: windowsRunner() }),
		}).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(LocalComputerSetupError)
		expect((error as Error).message).toContain('restart.json')
	})

	it('does not read a missing marker as a pending restart', async () => {
		expect((await inspectWith(windowsRunner())).state).toBe('image-missing')
	})
})

describe('virtualization-off without a probe', () => {
	const noHypervisor: Scenario = { hypervisor: 'False' }

	it('is restart-pending when Windows itself says a restart is pending', async () => {
		for (const key of [REBOOT_PENDING, REBOOT_REQUIRED]) {
			const runner = windowsRunner(noHypervisor)
			runner.set(key, 'HKEY_LOCAL_MACHINE\\...')
			const readiness = await inspectWith(runner)
			expect(readiness.state).toBe('restart-pending')
			// No marker of ours: nothing is recorded, and the answer says why only by state.
			expect(readiness.restart).toBeUndefined()
		}
	})

	it('is virtualization-off when no restart is pending', async () => {
		const readiness = await inspectWith(windowsRunner(noHypervisor))
		expect(readiness.state).toBe('virtualization-off')
	})

	it('does not call it virtualization-off when a restart marker cannot be read', async () => {
		// reg.exe exits 1 for "denied" as well as "absent": the parent decides.
		const runner = windowsRunner(noHypervisor)
		runner.set(REBOOT_PENDING, failure(1))
		runner.set(
			'reg query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing',
			failure(1),
		)
		const error = await inspectWith(runner).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(LocalComputerSetupError)
	})

	it('does not call it virtualization-off when a marker is listed but denied', async () => {
		const runner = windowsRunner(noHypervisor)
		runner.set(REBOOT_PENDING, failure(1))
		runner.set(
			'reg query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing',
			'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending\r\n',
		)
		const error = await inspectWith(runner).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(LocalComputerSetupError)
	})

	it('does not call it virtualization-off when the registry does not answer in time', async () => {
		vi.useFakeTimers()
		const { runner, started } = hanging(windowsRunner(noHypervisor), [REBOOT_PENDING])
		const pending = inspectWith(runner).catch((error: unknown) => error)
		await started.get(REBOOT_PENDING)
		await vi.advanceTimersByTimeAsync(PROBE_LIMIT_MS.command)
		expect(await pending).toBeInstanceOf(LocalComputerSetupError)
	})

	it('leaves the answer to the session with a probe: 0x80370102 stays virtualization-off', async () => {
		const runner = windowsRunner({ ...noHypervisor, imageInspect: failure(1, ['0x80370102']) })
		const readiness = await inspectWith(runner, { probe: true })
		expect(readiness.state).toBe('virtualization-off')
		expect(runner.calls).toContain(INSPECT)
	})

	it('does not consult the restart markers with a probe: the session decides', async () => {
		const runner = windowsRunner({ ...noHypervisor, imageInspect: failure(1, ['0x80370102']) })
		runner.set(REBOOT_PENDING, 'HKEY_LOCAL_MACHINE\\...')
		const readiness = await inspectWith(runner, { probe: true })
		expect(readiness.state).toBe('virtualization-off')
		expect(runner.calls).not.toContain(REBOOT_PENDING)
	})
})

describe('a failure the engine does not explain', () => {
	it('is not read as a missing image: the check could not be made', async () => {
		const runner = windowsRunner({ imageInspect: failure(7, ['0x80004005']) })
		const error = await inspectWith(runner, { probe: true }).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(LocalComputerSetupError)
		expect((error as Error).message).toBe(
			'Linux container support did not answer, so Namzu could not check this PC. Try again in a moment.',
		)
	})

	it('reads a bare non-zero exit as a missing image, as wslc 3.0.1 answers', async () => {
		const runner = windowsRunner({ imageInspect: failure(1) })
		expect((await inspectWith(runner, { probe: true })).state).toBe('image-missing')
	})

	it('does not read a command that never started as a missing image', async () => {
		const runner = windowsRunner({
			imageInspect: new LocalCommandError('could not be started', ['ENOENT']),
		})
		const error = await inspectWith(runner, { probe: true }).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(LocalComputerSetupError)
	})

	it('still reads the engine saying the image is not there as image-missing', async () => {
		const readiness = await inspectWith(windowsRunner(), { probe: true })
		expect(readiness.state).toBe('image-missing')
	})
})

describe('the processor type of the PC, not of the Node build', () => {
	it('reads PROCESSOR_ARCHITEW6432 before PROCESSOR_ARCHITECTURE', () => {
		expect(
			windowsArchitectureOf({ PROCESSOR_ARCHITEW6432: 'AMD64', PROCESSOR_ARCHITECTURE: 'x86' }),
		).toBe('x64')
		expect(
			windowsArchitectureOf({ PROCESSOR_ARCHITEW6432: 'ARM64', PROCESSOR_ARCHITECTURE: 'x86' }),
		).toBe('arm64')
		expect(windowsArchitectureOf({ PROCESSOR_ARCHITECTURE: 'AMD64' })).toBe('x64')
		expect(windowsArchitectureOf({ PROCESSOR_ARCHITECTURE: 'x86' })).toBe('x86')
	})

	it('gives the host that type on Windows whatever process.arch says', () => {
		const host = createWslcSetupHost({
			platform: 'win32',
			env: { PROCESSOR_ARCHITECTURE: 'ARM64' },
		})
		expect(host.arch).toBe('arm64')
	})

	it('finds wslc in the 64-bit Program Files from a 32-bit process', () => {
		expect(
			wslcBinaryOf({
				env: { ProgramFiles: 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files' },
			}),
		).toBe('C:\\Program Files\\WSL\\wslc.exe')
		expect(wslcBinaryOf({ env: { ProgramFiles: 'D:\\Programs' } })).toBe(
			'D:\\Programs\\WSL\\wslc.exe',
		)
	})
})

describe('the load estimate', () => {
	it('is about 5 seconds plus the archive at 150 MB/s (323 MB measured at 3.2 s)', () => {
		const readiness = {
			state: 'image-missing',
			policy: { allowWsl: true, allowWslContainer: true },
			components: {
				virtualMachinePlatform: true,
				wslOptionalComponent: 'not-needed',
				hypervisorPresent: true,
			},
			wsl: { wslcVersion: '3.0.1' },
			image: { ref: IMAGE_REF, loaded: false },
			checkedAt: '2026-10-12T12:00:00.000Z',
		} as const
		const plan = planWslcSetup(readiness, { manifest: MANIFEST })
		const load = plan.steps.find((step) => step.kind === 'load-image')
		expect(load?.estimatedSeconds).toBe(5 + Math.ceil(MANIFEST.compressedBytes / 150_000_000))
		expect(load?.estimatedSeconds).toBe(8)
	})
})

describe('loadWslcImage checks the size before it reads the archive', () => {
	it('fails a short archive whose bytes would pass the digest, and reports no hashing progress', async () => {
		const content = Buffer.from('a short archive')
		const sha = createHash('sha256').update(content).digest('hex')
		// The manifest promises more bytes than the file holds, but carries the
		// digest of what is there: only the size check can refuse it.
		const bundle = await writeBundle(directory, content, sha, {
			compressedBytes: content.byteLength + 10,
		})
		const runner = fakeRunner({ [INSPECT]: failure(1, ['WSLC_E_IMAGE_NOT_FOUND']) })
		const progress = vi.fn()
		const result = await loadWslcImage({
			manifestPath: bundle.manifestPath,
			host: fakeHost({ stateDirectory: directory, runner }),
			onProgress: progress,
		})
		expect(result).toMatchObject({ outcome: 'failed', code: 'image-corrupt' })
		expect(progress).not.toHaveBeenCalled()
		expect(runner.calls).toEqual([INSPECT])
	})

	it('names a different image after the load as a mismatch (the swap window)', async () => {
		const content = Buffer.from('the archive')
		const sha = createHash('sha256').update(content).digest('hex')
		const bundle = await writeBundle(directory, content, sha)
		let loaded = false
		const runner = fakeRunner({
			[INSPECT]: () =>
				loaded ? inspectJson(`sha256:${'d'.repeat(64)}`) : failure(1, ['WSLC_E_IMAGE_NOT_FOUND']),
			[`wslc load -q -i ${bundle.archivePath}`]: () => {
				loaded = true
				return ''
			},
		})
		const result = await loadWslcImage({
			manifestPath: bundle.manifestPath,
			host: fakeHost({ stateDirectory: directory, runner }),
		})
		expect(result).toMatchObject({ outcome: 'failed', code: 'image-mismatch' })
		expect(IMAGE_ID).not.toBe(`sha256:${'d'.repeat(64)}`)
	})
})
