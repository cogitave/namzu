import type * as SetupModule from '@namzu/sandbox/local-virtual-computer/setup'
import {
	type PalComputerInput,
	type PalEnvironmentProvider,
	type PalEnvironmentRequest,
	PalRuntime,
} from '@namzu/sdk'
import { DEFAULT_PAL_COMPUTER_IMAGE, readPalComputerBundle } from '../computer/bundle.js'
import { getCliPalStore } from './store.js'

interface LocalComputerProvider extends PalEnvironmentProvider {
	probe(): Promise<{ ready: boolean; reason?: string }>
}

/** What the model is told when the person has not set the computer up. */
export const COMPUTER_NOT_SET_UP_FOR_MODEL =
	'The computer is not set up; the person can set it up from Namzu.'

/** The line Windows people read after an engine or image failure. */
export const RUN_COMPUTER_SETUP_LINE = 'Run namzu computer setup to set this up.'

const SETTABLE_UP = new Set(['engine-missing', 'engine-too-old', 'image-missing'])

/**
 * Setup the person can do from Namzu surfaces to the model as one sentence;
 * every other failure, including a setup error nothing in Namzu can fix, keeps
 * its own words. Matches by name and code so the optional leaf stays a dynamic
 * import.
 */
export function modelFacingComputerError(error: unknown): unknown {
	if (
		error instanceof Error &&
		error.name === 'LocalComputerSetupError' &&
		SETTABLE_UP.has(String((error as { code?: unknown }).code))
	) {
		return new Error(COMPUTER_NOT_SET_UP_FOR_MODEL, { cause: error })
	}
	return error
}

/**
 * The probe returns prose, not a code, so the hint is anchored to the exact
 * texts the sandbox gives for the three setups Namzu can do (engine missing,
 * engine too old, image missing). This couples to the sandbox's wording on
 * purpose: a reworded message loses the hint, never gains it on a policy or
 * virtualization block. The test pins these strings.
 */
const SETTABLE_UP_REASONS = new Set([
	'Windows Linux container support (wslc) is not installed on this PC.',
	'Windows Linux container support on this PC is too old for Namzu.',
])
const FINISH_FROM_PAL = ' finish the setup from the Pal computer and try again.'
// Each sandbox text carries its own tail, singular or plural, removed as written.
const SETTABLE_UP_WITH_TAIL = new Map([
	[
		`The Pal computer is not set up on this PC yet. Namzu sets it up;${FINISH_FROM_PAL}`,
		' Namzu sets it up;' + FINISH_FROM_PAL,
	],
	[
		`Windows Linux container support and the Pal computer image are required. Namzu sets them up;${FINISH_FROM_PAL}`,
		' Namzu sets them up;' + FINISH_FROM_PAL,
	],
])

/** On Windows an unready engine or image ends with where to fix it. */
export function withSetupHint(
	reason: string | undefined,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (platform !== 'win32' || reason === undefined) return reason
	if (SETTABLE_UP_REASONS.has(reason)) return `${reason} ${RUN_COMPUTER_SETUP_LINE}`
	const tail = SETTABLE_UP_WITH_TAIL.get(reason)
	if (tail !== undefined) return `${reason.slice(0, -tail.length)} ${RUN_COMPUTER_SETUP_LINE}`
	return reason
}

let host: Promise<{ runtime: PalRuntime; provider: LocalComputerProvider }> | undefined

async function environment(): Promise<{
	runtime: PalRuntime
	provider: LocalComputerProvider
}> {
	if (!host) {
		host = (async () => {
			// The optional leaf is composed here, never imported by the SDK.
			const packageName = '@namzu/sandbox'
			const engineValue = process.env.NAMZU_PAL_COMPUTER_ENGINE
			if (
				engineValue &&
				engineValue !== 'docker' &&
				engineValue !== 'podman' &&
				engineValue !== 'wslc'
			)
				throw new Error('NAMZU_PAL_COMPUTER_ENGINE must be docker, podman or wslc.')
			const engine =
				engineValue === 'podman' || engineValue === 'wslc' || engineValue === 'docker'
					? engineValue
					: undefined
			// A bundled image is named by its manifest; an explicit image wins.
			const image =
				process.env.NAMZU_PAL_COMPUTER_IMAGE ||
				(engine === 'wslc'
					? readPalComputerBundle(process.env.NAMZU_PAL_COMPUTER_BUNDLE)?.imageRef
					: undefined)
			const exitPolicy = process.env.NAMZU_PAL_COMPUTER_NORMAL_EXIT_POLICY ?? 'computer-lifetime'
			if (exitPolicy !== 'strict' && exitPolicy !== 'computer-lifetime')
				throw new Error(
					'NAMZU_PAL_COMPUTER_NORMAL_EXIT_POLICY must be strict or computer-lifetime.',
				)
			const module = (await import(packageName)) as {
				createLocalVirtualComputerProvider(options: {
					image?: string
					normalExitPolicy?: 'strict' | 'computer-lifetime'
					dockerBinary?: string
					engine?: 'docker' | 'podman' | 'wslc'
					podmanBinary?: string
					wslcBinary?: string
					podmanMachine?: string
					podmanConnection?: string
				}): LocalComputerProvider
			}
			const provider = module.createLocalVirtualComputerProvider({
				normalExitPolicy: exitPolicy,
				...(engine ? { engine } : {}),
				...(image ? { image } : {}),
				...(process.env.NAMZU_PAL_DOCKER_BINARY
					? { dockerBinary: process.env.NAMZU_PAL_DOCKER_BINARY }
					: {}),
				...(process.env.NAMZU_PAL_PODMAN_BINARY
					? { podmanBinary: process.env.NAMZU_PAL_PODMAN_BINARY }
					: {}),
				...(process.env.NAMZU_PAL_WSLC_BINARY
					? { wslcBinary: process.env.NAMZU_PAL_WSLC_BINARY }
					: {}),
				...(process.env.NAMZU_PAL_PODMAN_MACHINE
					? { podmanMachine: process.env.NAMZU_PAL_PODMAN_MACHINE }
					: {}),
				...(process.env.NAMZU_PAL_PODMAN_CONNECTION
					? { podmanConnection: process.env.NAMZU_PAL_PODMAN_CONNECTION }
					: {}),
			})
			const guarded: LocalComputerProvider = Object.assign(Object.create(provider), {
				probe: async () => {
					const probe = await provider.probe()
					return probe.ready ? probe : { ...probe, reason: withSetupHint(probe.reason) }
				},
				acquire: async (request: PalEnvironmentRequest) => {
					try {
						return await provider.acquire(request)
					} catch (error) {
						throw modelFacingComputerError(error)
					}
				},
			})
			return {
				runtime: new PalRuntime({
					store: getCliPalStore(),
					environments: guarded,
				}),
				provider: guarded,
			}
		})().catch((error) => {
			host = undefined
			throw error
		})
	}
	return host
}

export async function getCliPalRuntime(): Promise<PalRuntime> {
	return (await environment()).runtime
}

/** Observe an already initialized runtime without loading an optional computer provider. */
export async function existingCliPalRuntime(): Promise<PalRuntime | null> {
	return host ? (await host).runtime : null
}

function readyComputer(runtime: PalRuntime, palId: string) {
	const lease = runtime.computer(palId)
	return lease && (lease.sandbox.status === 'ready' || lease.sandbox.status === 'busy')
		? {
				status: 'ready' as const,
				environmentId: lease.environmentId,
				generation: String(lease.generation),
				control: runtime.computerControl(palId),
			}
		: null
}

export interface QuietProbeDeps {
	readonly platform: NodeJS.Platform
	readonly env: NodeJS.ProcessEnv
	readonly loadSetup: () => Promise<typeof SetupModule>
}

const realQuietProbeDeps: QuietProbeDeps = {
	platform: process.platform,
	env: process.env,
	// The optional leaf is composed here, never imported by the SDK.
	loadSetup: async () =>
		(await import('@namzu/sandbox/local-virtual-computer/setup' as string)) as typeof SetupModule,
}

const NOT_READY_REASON =
	'Windows Linux container support and the Pal computer image are required. Namzu sets them up; finish the setup from the Pal computer and try again.'

/**
 * Whether the computer could start, asked without starting anything. With the Windows engine the
 * engine's own probe starts the Linux machine (about 2 GB), and status is read every few seconds
 * while a Pal's panel is open: that would bring the machine back right after it was stopped for
 * being idle. Readiness comes from what setup recorded instead; any other engine probes as before.
 */
export async function quietComputerProbe(
	provider: LocalComputerProvider,
	deps: QuietProbeDeps = realQuietProbeDeps,
): Promise<{ ready: boolean; reason?: string }> {
	if (deps.platform !== 'win32' || deps.env.NAMZU_PAL_COMPUTER_ENGINE !== 'wslc')
		return provider.probe()
	try {
		const setup = await deps.loadSetup()
		const bundle = readPalComputerBundle(deps.env.NAMZU_PAL_COMPUTER_BUNDLE)
		const readiness = await setup.inspectWslcReadiness({
			imageRef: deps.env.NAMZU_PAL_COMPUTER_IMAGE || bundle?.imageRef || DEFAULT_PAL_COMPUTER_IMAGE,
			...(bundle ? { bundledManifestPath: bundle.manifestPath } : {}),
		})
		return readiness.state === 'ready'
			? { ready: true }
			: { ready: false, reason: withSetupHint(NOT_READY_REASON, deps.platform) }
	} catch {
		return provider.probe()
	}
}

export async function cliPalComputerStatus(palId: string) {
	if (!getCliPalStore().get(palId)) throw new Error('This Pal is unavailable.')
	try {
		const { runtime, provider } = await environment()
		const failure = runtime.computerError(palId)
		if (failure) return { status: 'unavailable' as const, notice: failure, requiresStop: true }
		const held = readyComputer(runtime, palId)
		if (held) return held
		if (runtime.computerChanging(palId))
			return {
				status: 'unavailable' as const,
				notice: 'This Pal computer is still changing state. Wait for the operation to finish.',
			}
		const probe = await quietComputerProbe(provider)
		return probe.ready
			? { status: 'stopped' as const }
			: {
					status: 'unavailable' as const,
					notice: probe.reason ?? 'Local computer is unavailable.',
				}
	} catch (error) {
		return {
			status: 'unavailable' as const,
			notice: error instanceof Error ? error.message : String(error),
		}
	}
}

export async function startCliPalComputer(palId: string) {
	const runtime = await getCliPalRuntime()
	await runtime.startComputer(palId)
	const computer = readyComputer(runtime, palId)
	if (!computer) throw new Error('The Pal computer did not finish starting.')
	return computer
}

export async function stopCliPalComputer(palId: string) {
	const runtime = await getCliPalRuntime()
	await runtime.stopComputer(palId)
	return { status: 'stopped' as const }
}

function computerGeneration(generation: string): number {
	if (typeof generation !== 'string' || !/^[1-9][0-9]{0,15}$/.test(generation))
		throw new Error('Invalid Pal computer generation.')
	const value = Number(generation)
	if (!Number.isSafeInteger(value) || value < 1 || String(value) !== generation)
		throw new Error('Invalid Pal computer generation.')
	return value
}

export async function takeOverCliPalComputer(palId: string, generation: string) {
	const expected = computerGeneration(generation)
	const runtime = await getCliPalRuntime()
	await runtime.takeOver(palId, expected)
	const computer = readyComputer(runtime, palId)
	if (!computer || computer.generation !== generation)
		throw new Error('This Pal computer changed while taking operator control.')
	return computer
}

export async function returnCliPalComputerControl(palId: string, generation: string) {
	const expected = computerGeneration(generation)
	const runtime = await getCliPalRuntime()
	await runtime.returnControl(palId, expected)
	const computer = readyComputer(runtime, palId)
	if (!computer || computer.generation !== generation)
		throw new Error('This Pal computer changed while returning Pal control.')
	return computer
}

export async function executeCliPalComputerInput(
	palId: string,
	generation: string,
	input: PalComputerInput,
) {
	const expected = computerGeneration(generation)
	const runtime = await getCliPalRuntime()
	const result = await runtime.executeOperatorInput(palId, expected, input)
	if (result.type !== 'ok') throw new Error('The Pal computer did not confirm operator input.')
	return { type: 'ok' as const }
}

export async function cliPalScreen(palId: string, generation?: string) {
	const expected = generation === undefined ? undefined : computerGeneration(generation)
	const runtime = await getCliPalRuntime()
	const lease = runtime.computer(palId)
	if (!lease) throw new Error('Start this Pal computer before opening its screen.')
	const capturedGeneration = lease.generation
	if (expected !== undefined && lease.generation !== expected)
		throw new Error('This Pal computer generation changed before its screen capture.')
	const response = await lease.computerUseHost.execute({ type: 'screenshot' })
	if (runtime.computer(palId) !== lease || lease.generation !== capturedGeneration)
		throw new Error('This Pal computer generation changed during its screen capture.')
	if (response.type !== 'screenshot')
		throw new Error('The Pal computer did not return a screen capture.')
	const result = response.result
	if (result.mimeType !== 'image/png' || !Buffer.isBuffer(result.data))
		throw new Error('The Pal computer did not return a PNG screen capture.')
	if (result.data.length > 5_000_000) throw new Error('This screen capture is too large.')
	return {
		source: `data:image/png;base64,${result.data.toString('base64')}`,
		width: result.width,
		height: result.height,
	}
}

/** Host-only ACP result. Desktop main proxies this credential instead of exposing it. */
export async function cliPalScreenStream(palId: string, generation: string) {
	const expected = computerGeneration(generation)
	const runtime = await getCliPalRuntime()
	const descriptor = runtime.computerScreenStream(palId, expected)
	const lease = runtime.computer(palId)
	if (!lease) throw new Error('This Pal computer generation is unavailable or changed.')
	const geometry = await lease.computerUseHost.getDisplayGeometry()
	const current = runtime.computerScreenStream(palId, expected)
	if (
		runtime.computer(palId) !== lease ||
		lease.generation !== expected ||
		current.url !== descriptor.url ||
		current.authorization !== descriptor.authorization
	)
		throw new Error('This Pal computer generation changed while opening its live screen.')
	if (
		!Number.isSafeInteger(geometry.width) ||
		!Number.isSafeInteger(geometry.height) ||
		geometry.width < 1 ||
		geometry.height < 1 ||
		geometry.width > 4096 ||
		geometry.height > 3072
	)
		throw new Error('The Pal computer returned an invalid live screen size.')
	return { ...descriptor, width: geometry.width, height: geometry.height, generation }
}

export async function closeCliPalRuntime(): Promise<void> {
	const closing = host
	if (!closing) return
	await (await closing).runtime.close()
	if (host === closing) host = undefined
}
