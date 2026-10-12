import {
	type PalComputerInput,
	type PalEnvironmentProvider,
	type PalEnvironmentRequest,
	PalRuntime,
} from '@namzu/sdk'
import { readPalComputerBundle } from '../computer/bundle.js'
import { getCliPalStore } from './store.js'

interface LocalComputerProvider extends PalEnvironmentProvider {
	/** `setupCode` is the sandbox's own code for a failure that setup can fix. */
	probe(): Promise<{ ready: boolean; reason?: string; setupCode?: string }>
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
 * What the person reads for each setup the sandbox reports by code. The words
 * are Namzu's own, so the hint never depends on how the sandbox phrases its
 * message; a setup error with any other code, or none, keeps its own words.
 */
const SETTABLE_UP_TEXT: Record<string, string> = {
	'engine-missing': 'Linux container support is not installed on this PC.',
	'engine-too-old': 'Linux container support on this PC is too old for Namzu.',
	'image-missing': 'The Pal computer is not set up on this PC yet.',
}

/** On Windows an unready engine or image ends with where to fix it. */
export function withSetupHint(
	probe: { readonly reason?: string; readonly setupCode?: string },
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	if (platform !== 'win32' || probe.reason === undefined) return probe.reason
	const text = probe.setupCode === undefined ? undefined : SETTABLE_UP_TEXT[probe.setupCode]
	return text === undefined ? probe.reason : `${text} ${RUN_COMPUTER_SETUP_LINE}`
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
					return probe.ready ? probe : { ...probe, reason: withSetupHint(probe) }
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
		const probe = await provider.probe()
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
