import { type PalComputerInput, type PalEnvironmentProvider, PalRuntime } from '@namzu/sdk'
import { getCliPalStore } from './store.js'

interface LocalComputerProvider extends PalEnvironmentProvider {
	probe(): Promise<{ ready: boolean; reason?: string }>
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
			if (engineValue && engineValue !== 'docker' && engineValue !== 'podman')
				throw new Error('NAMZU_PAL_COMPUTER_ENGINE must be docker or podman.')
			const engine =
				engineValue === 'podman' ? 'podman' : engineValue === 'docker' ? 'docker' : undefined
			const module = (await import(packageName)) as {
				createLocalVirtualComputerProvider(options: {
					image?: string
					dockerBinary?: string
					engine?: 'docker' | 'podman'
					podmanBinary?: string
					podmanMachine?: string
					podmanConnection?: string
				}): LocalComputerProvider
			}
			const provider = module.createLocalVirtualComputerProvider({
				...(engine ? { engine } : {}),
				...(process.env.NAMZU_PAL_COMPUTER_IMAGE
					? { image: process.env.NAMZU_PAL_COMPUTER_IMAGE }
					: {}),
				...(process.env.NAMZU_PAL_DOCKER_BINARY
					? { dockerBinary: process.env.NAMZU_PAL_DOCKER_BINARY }
					: {}),
				...(process.env.NAMZU_PAL_PODMAN_BINARY
					? { podmanBinary: process.env.NAMZU_PAL_PODMAN_BINARY }
					: {}),
				...(process.env.NAMZU_PAL_PODMAN_MACHINE
					? { podmanMachine: process.env.NAMZU_PAL_PODMAN_MACHINE }
					: {}),
				...(process.env.NAMZU_PAL_PODMAN_CONNECTION
					? { podmanConnection: process.env.NAMZU_PAL_PODMAN_CONNECTION }
					: {}),
			})
			return {
				runtime: new PalRuntime({
					store: getCliPalStore(),
					environments: provider,
				}),
				provider,
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
		if (runtime.busy(palId))
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

export async function closeCliPalRuntime(): Promise<void> {
	const closing = host
	if (!closing) return
	await (await closing).runtime.close()
	if (host === closing) host = undefined
}
