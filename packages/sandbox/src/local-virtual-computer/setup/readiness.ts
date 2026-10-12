import { stat } from 'node:fs/promises'
import {
	LocalCommandError,
	type LocalComputerCommandRunner,
	LocalComputerSetupError,
} from '../engine.js'
import { WSLC_MINIMUM_VERSION, mapWslcFailure, parseWslcVersion } from '../wslc-engine.js'
import type {
	InspectWslcReadiness,
	WslcReadiness,
	WslcReadinessState,
	WslcSetupHost,
	WslcUnsupportedReason,
} from './contract.js'
import { createWslcSetupHost } from './host.js'
import { PROBE_LIMIT_MS, ProbeTimeoutError, runLimited } from './limits.js'
import { clearRestartMarker, readRestartMarker } from './restart.js'
import {
	archivePathOf,
	parseImageInspect,
	readImageRecord,
	readManifest,
	wslcBinaryOf,
} from './wslc-shared.js'

const POLICY_KEY = 'HKLM\\Software\\Policies\\WSL'
/** Windows' own pending-restart markers; both can be read without administrator rights. */
const PENDING_RESTART_KEYS = [
	'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
	'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired',
] as const
const MINIMUM_BUILD = 19041
const WINDOWS_11_BUILD = 22000

/** `wsl.exe --version` is UTF-16LE and localised: strip NULs, never read a label. */
export function parseWslVersion(output: string): string | undefined {
	const text = output.replace(/\0/g, '').replace(/^﻿/, '')
	const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
	return /\d+\.\d+\.\d+\.\d+/.exec(firstLine)?.[0]
}

export function wslcAtLeastMinimum(version: string): boolean {
	const parts = version.split('.').map(Number)
	for (let i = 0; i < WSLC_MINIMUM_VERSION.length; i++) {
		const found = parts[i] ?? 0
		const floor = WSLC_MINIMUM_VERSION[i] ?? 0
		if (found !== floor) return found > floor
	}
	return true
}

/** 1060 is "service does not exist"; any other failure leaves it unknown. */
async function serviceExists(
	runner: LocalComputerCommandRunner,
	name: string,
	signal: AbortSignal | undefined,
): Promise<boolean | 'unknown'> {
	try {
		await runLimited(runner, 'sc.exe', ['query', name], PROBE_LIMIT_MS.command, { signal })
		return true
	} catch (error) {
		signal?.throwIfAborted()
		if (error instanceof LocalCommandError && /\(1060\)/.test(error.message)) return false
		return 'unknown'
	}
}

async function hypervisorPresent(
	runner: LocalComputerCommandRunner,
	signal: AbortSignal | undefined,
): Promise<boolean | 'unknown'> {
	try {
		const output = await runLimited(
			runner,
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				'(Get-CimInstance Win32_ComputerSystem).HypervisorPresent',
			],
			PROBE_LIMIT_MS.powershell,
			{ signal },
		)
		const answer = output.trim().toLowerCase()
		if (answer === 'true') return true
		if (answer === 'false') return false
		return 'unknown'
	} catch {
		signal?.throwIfAborted()
		return 'unknown'
	}
}

async function wslVersionOf(
	runner: LocalComputerCommandRunner,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	try {
		return parseWslVersion(
			await runLimited(runner, 'wsl.exe', ['--version'], PROBE_LIMIT_MS.command, { signal }),
		)
	} catch {
		signal?.throwIfAborted()
		return undefined
	}
}

async function wslcVersionOf(
	runner: LocalComputerCommandRunner,
	binary: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	try {
		const parsed = parseWslcVersion(
			await runLimited(runner, binary, ['version'], PROBE_LIMIT_MS.command, { signal }),
		)
		return parsed?.join('.')
	} catch (error) {
		signal?.throwIfAborted()
		// Without an answer there is no telling "not installed" from "slow": the
		// state cannot be decided, so say so rather than plan an install.
		if (error instanceof ProbeTimeoutError) throw couldNotCheck(error)
		return undefined
	}
}

/** The state cannot be decided: a plain message the CLI and Desktop show with Details. */
function couldNotCheck(cause: unknown): LocalComputerSetupError {
	return new LocalComputerSetupError(
		'Linux container support did not answer, so Namzu could not check this PC. Try again in a moment.',
		undefined,
		{ cause },
	)
}

/** Windows' own markers that a restart is pending. */
async function windowsWantsRestart(host: WslcSetupHost): Promise<boolean> {
	for (const key of PENDING_RESTART_KEYS) {
		if ((await host.keyExists(key)) === true) return true
	}
	return false
}

async function bundledOf(
	manifestPath: string | undefined,
): Promise<{ manifestPath: string; archivePath: string; imageId: string } | undefined> {
	if (manifestPath === undefined) return undefined
	try {
		const manifest = await readManifest(manifestPath)
		const archivePath = archivePathOf(manifestPath, manifest)
		await stat(archivePath)
		return { manifestPath, archivePath, imageId: manifest.imageId }
	} catch {
		return undefined
	}
}

type ProbeResult =
	| { readonly kind: 'loaded' | 'absent' }
	| { readonly kind: 'state'; readonly state: WslcReadinessState }

/** Start the session (wslc image inspect does) and see what answers. */
async function probeImage(
	host: WslcSetupHost,
	binary: string,
	ref: string,
	expectedId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<ProbeResult> {
	try {
		const output = await runLimited(
			host.runner,
			binary,
			['image', 'inspect', '-f', 'json', ref],
			PROBE_LIMIT_MS.session,
			{ signal },
		)
		const found = parseImageInspect(output)
		if (found === undefined) return { kind: 'absent' }
		return expectedId === undefined || found.id === expectedId
			? { kind: 'loaded' }
			: { kind: 'absent' }
	} catch (error) {
		signal?.throwIfAborted()
		const mapped = mapWslcFailure(error)
		if (mapped?.code === 'virtualization-off') return { kind: 'state', state: 'virtualization-off' }
		if (mapped?.code === 'blocked-by-policy') return { kind: 'state', state: 'blocked-by-policy' }
		if (mapped?.code === 'sdk-mismatch') return { kind: 'state', state: 'sdk-mismatch' }
		if (mapped?.code === 'image-missing') return { kind: 'absent' }
		// Anything else is the engine failing, not the image being absent.
		throw couldNotCheck(error)
	}
}

/**
 * Inspect the PC without changing anything. Without `probeSession` no command
 * runs that starts the wslc session (`wslc version` does not; `ps` and `image`
 * do), so opening a panel never starts a virtual machine.
 */
export const inspectWslcReadiness: InspectWslcReadiness = async (options) => {
	const host = createWslcSetupHost(options.host)
	const { signal } = options
	const checkedAt = host.now().toISOString()
	const bundled = await bundledOf(options.bundledManifestPath)
	const bundledPaths = bundled
		? { manifestPath: bundled.manifestPath, archivePath: bundled.archivePath }
		: undefined
	const base = {
		policy: { allowWsl: true, allowWslContainer: true },
		components: {
			virtualMachinePlatform: 'unknown' as const,
			wslOptionalComponent: 'unknown' as const,
			hypervisorPresent: 'unknown' as const,
		},
		wsl: {},
		image: {
			ref: options.imageRef,
			loaded: false,
			...(bundledPaths ? { bundled: bundledPaths } : {}),
		},
		checkedAt,
	}

	let unsupported: WslcUnsupportedReason | undefined
	if (host.platform !== 'win32') unsupported = 'platform'
	else if (host.arch !== 'x64') unsupported = 'architecture'
	else if (host.windowsBuild === undefined || host.windowsBuild < MINIMUM_BUILD)
		unsupported = 'windows-build'
	if (unsupported !== undefined || host.windowsBuild === undefined) {
		return {
			state: 'unsupported',
			unsupportedReason: unsupported ?? 'windows-build',
			...base,
		}
	}

	const build = host.windowsBuild
	const isWindows11 = build >= WINDOWS_11_BUILD
	const binary = wslcBinaryOf(host)
	const { runner } = host

	const [
		allowWsl,
		allowContainer,
		markerRead,
		hns,
		vmcompute,
		lxss,
		hypervisor,
		wslVersion,
		wslcVersion,
	] = await Promise.all([
		host.readDword(POLICY_KEY, 'AllowWSL'),
		host.readDword(POLICY_KEY, 'AllowWSLContainer'),
		readRestartMarker(host).then(
			(marker) => ({ marker }),
			() => ({ marker: undefined, unreadable: true as const }),
		),
		serviceExists(runner, 'HNS', signal),
		serviceExists(runner, 'vmcompute', signal),
		isWindows11
			? Promise.resolve('not-needed' as const)
			: serviceExists(runner, 'LxssManager', signal),
		hypervisorPresent(runner, signal),
		wslVersionOf(runner, signal),
		wslcVersionOf(runner, binary, signal),
	])

	const policy = { allowWsl: allowWsl !== 0, allowWslContainer: allowContainer !== 0 }
	const vmp: boolean | 'unknown' =
		hns === false || vmcompute === false
			? false
			: hns === true && vmcompute === true
				? true
				: 'unknown'
	const components = {
		virtualMachinePlatform: vmp,
		wslOptionalComponent: lxss,
		hypervisorPresent: hypervisor,
	}

	let restart: WslcReadiness['restart']
	const { marker } = markerRead
	if ('unreadable' in markerRead) {
		// A marker that cannot be read (anything but "not there") leaves a restart
		// pending with no steps known to follow it.
		restart = { recordedAt: checkedAt }
	} else if (marker !== undefined) {
		let boot: Date | undefined
		try {
			boot = await host.bootTime()
		} catch {
			signal?.throwIfAborted()
		}
		if (boot === undefined) restart = { recordedAt: marker.recordedAt }
		else if (boot.getTime() > Date.parse(marker.recordedAt)) {
			try {
				await clearRestartMarker(host)
			} catch {
				// A marker that stays is checked again next time; the PC has restarted.
			}
		} else restart = { recordedAt: marker.recordedAt, bootTime: boot.toISOString() }
	}

	const wsl = {
		...(wslVersion ? { version: wslVersion } : {}),
		...(wslcVersion ? { wslcBinary: binary, wslcVersion } : {}),
	}
	const wslcUsable = wslcVersion !== undefined && wslcAtLeastMinimum(wslcVersion)

	let loaded = false
	if (options.probeSession !== true) {
		const record = await readImageRecord(host)
		loaded =
			record !== undefined &&
			record.imageRef === options.imageRef &&
			(bundled === undefined || record.imageId === bundled.imageId)
	}

	const result = (state: WslcReadinessState, imageLoaded = loaded): WslcReadiness => ({
		state,
		windows: { build, architecture: 'x64', isWindows11 },
		policy,
		components,
		wsl,
		image: { ...base.image, loaded: imageLoaded },
		...(restart ? { restart } : {}),
		checkedAt,
	})

	if (!policy.allowWsl || !policy.allowWslContainer) return result('blocked-by-policy')
	if (restart) return result('restart-pending')
	if (vmp === false || lxss === false) return result('platform-off')
	if (!wslcUsable) return result(wslVersion ? 'wsl-outdated' : 'wsl-missing')
	if (vmp === true && hypervisor === false) {
		// Turning the platform on outside Namzu leaves no hypervisor until the PC
		// restarts; Windows says so in its own markers. Only without one is it
		// the firmware setting. With a probe the session's own failure decides.
		if (await windowsWantsRestart(host)) return result('restart-pending')
		if (options.probeSession !== true) return result('virtualization-off')
	}

	if (options.probeSession === true) {
		const probe = await probeImage(host, binary, options.imageRef, bundled?.imageId, signal)
		if (probe.kind === 'state') return result(probe.state)
		loaded = probe.kind === 'loaded'
	}
	return result(loaded ? 'ready' : 'image-missing', loaded)
}
