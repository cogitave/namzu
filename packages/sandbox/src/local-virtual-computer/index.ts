import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PalEnvironmentLease, PalEnvironmentProvider, PalEnvironmentRequest } from '@namzu/sdk'
import { OperationDeadline } from '../backends/readiness.js'
import { localComputerClients } from './client.js'
import {
	type LocalComputerCommandRunner,
	LocalComputerSetupError,
	type LocalEngine,
	type LocalPortForward,
	resolveLocalEngine,
} from './engine.js'
import { resolveLocalPodmanEngine } from './podman-machine.js'
import { LocalForwardCleanupError } from './ssh-forward.js'

export type { LocalComputerCommandRunner } from './engine.js'

export const LOCAL_COMPUTER_IMAGE = 'namzu-local-computer:1'
export const LOCAL_COMPUTER_PROTOCOL_LABEL = 'org.namzu.local-computer.protocol'
const OWNER_LABEL = 'org.namzu.pal.owner'

/** Uses an already installed local engine and an already built guest image. */
export interface LocalVirtualComputerOptions {
	readonly image?: string
	/** Docker remains the default. Podman requires an explicitly selected local Windows WSL machine. */
	readonly engine?: 'docker' | 'podman'
	readonly dockerBinary?: string
	readonly podmanBinary?: string
	readonly podmanMachine?: string
	readonly podmanConnection?: string
	readonly engineEndpoint?: string
	readonly readyTimeoutMs?: number
	readonly width?: number
	readonly height?: number
	/** Host transport injection for embedders/tests; contains authority, never model input. */
	readonly runner?: LocalComputerCommandRunner
}

function dimension(value: number | undefined, fallback: number): number {
	const result = value ?? fallback
	if (!Number.isSafeInteger(result) || result < 320 || result > 3840)
		throw new Error('The Pal display dimensions must be integers between 320 and 3840')
	return result
}

function ownerFor(palId: string): string {
	return createHash('sha256').update(palId).digest('hex')
}

async function verifyImage(
	engine: LocalEngine,
	image: string,
	signal?: AbortSignal,
): Promise<void> {
	let images: {
		Os?: string
		Config?: { Labels?: Record<string, string>; User?: string }
	}[]
	try {
		images = JSON.parse(await engine.run(['image', 'inspect', image], { signal })) as typeof images
	} catch {
		signal?.throwIfAborted()
		throw new LocalComputerSetupError(
			`The ${image} image is not installed on this local engine. Build packages/sandbox/local-computer/Dockerfile explicitly; Namzu does not pull or build it automatically.`,
		)
	}
	if (
		images[0]?.Os !== 'linux' ||
		images[0]?.Config?.Labels?.[LOCAL_COMPUTER_PROTOCOL_LABEL] !== '1' ||
		images[0]?.Config?.User !== '1001:1001'
	)
		throw new LocalComputerSetupError(
			'The local Pal computer image must declare the Namzu desktop protocol and non-root guest user; rebuild the shipped Dockerfile',
		)
}

function portFor(
	ports: Record<string, { HostIp?: string; HostPort?: string }[]>,
	port: number,
): number {
	const mappings = ports[`${port}/tcp`]
	if (!mappings || mappings.length !== 1 || mappings[0]?.HostIp !== '127.0.0.1')
		throw new Error('The Pal computer control port must be published on IPv4 loopback only')
	const result = Number(mappings[0].HostPort)
	if (!Number.isSafeInteger(result) || result < 1 || result > 65535)
		throw new Error('The Pal computer control port was not allocated')
	return result
}

/**
 * A separate guest desktop in a local Linux container. It does not provision
 * a dedicated-kernel VM and never falls back to the operator's desktop.
 */
export function createLocalVirtualComputerProvider(
	options: LocalVirtualComputerOptions = {},
): PalEnvironmentProvider {
	if (options.engine !== undefined && options.engine !== 'docker' && options.engine !== 'podman')
		throw new Error('Choose the Docker or Podman local computer engine')
	const image = options.image ?? LOCAL_COMPUTER_IMAGE
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(image))
		throw new Error('Invalid local Pal image reference')
	const width = dimension(options.width, 1280)
	const height = dimension(options.height, 800)
	const timeout = options.readyTimeoutMs ?? 60_000
	if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
		throw new Error('Invalid Pal computer readiness timeout')
	const holders = new Set<string>()
	const pendingCleanup = new Map<string, (signal?: AbortSignal) => Promise<void>>()
	let generation = 0
	const prepare = async (signal?: AbortSignal) => {
		const engine =
			options.engine === 'podman'
				? await resolveLocalPodmanEngine(options, signal)
				: await resolveLocalEngine(options, signal)
		await verifyImage(engine, image, signal)
		return engine
	}
	return {
		async probe() {
			try {
				await new OperationDeadline(timeout, 'local Pal computer probe').run(
					async (signal) => await prepare(signal),
				)
				return { ready: true }
			} catch (error) {
				return {
					ready: false,
					reason:
						error instanceof LocalComputerSetupError
							? error.message
							: `A local ${options.engine === 'podman' ? 'Podman machine' : 'Docker engine'} running Linux containers and the ${image} image are required. Build packages/sandbox/local-computer/Dockerfile explicitly; Namzu does not install or pull it automatically.`,
				}
			}
		},
		async acquire(request: PalEnvironmentRequest): Promise<PalEnvironmentLease> {
			request.signal?.throwIfAborted()
			if (request.pal.paused) throw new Error('This Pal is paused')
			if (!request.pal.id || !request.conversationId)
				throw new Error('A Pal and conversation identity are required')
			const owner = ownerFor(request.pal.id)
			if (holders.has(owner)) {
				const cleanup = pendingCleanup.get(owner)
				if (!cleanup) throw new Error('This Pal computer is already in use')
				try {
					await new OperationDeadline(timeout, 'local Pal computer recovery', request.signal).run(
						async (signal) => await cleanup(signal),
					)
				} catch {
					throw new Error(
						'This Pal computer is already in use by an unconfirmed allocation; cleanup recovery is still required',
					)
				}
				pendingCleanup.delete(owner)
				holders.delete(owner)
			}
			holders.add(owner)
			const name = `namzu-pal-${owner.slice(0, 24)}`
			const volume = `namzu-pal-data-${owner}`
			const environmentId = `local-container:${owner}`
			const token = randomBytes(32).toString('base64url')
			const allocationId = randomUUID()
			generation = Math.max(Date.now(), generation + 1)
			const leaseGeneration = generation
			let engine: LocalEngine | undefined
			let created = false
			let runAttempted = false
			let containerId: string | undefined
			let forwarding: LocalPortForward | undefined
			let clients: ReturnType<typeof localComputerClients> | undefined
			const stop = async (signal?: AbortSignal) => {
				if (!engine) return
				// Only the name we successfully created is removed. No volume is
				// deleted; profile/files survive the next allocation.
				if (created) {
					// Commit the browser profile before removing this allocation.
					// Forced removal remains the recovery path if graceful stop fails.
					try {
						await engine.run(['stop', '--time', '10', containerId ?? name], { signal })
					} catch {
						signal?.throwIfAborted()
					}
					await engine.run(['rm', '-f', containerId ?? name], { signal })
					created = false
				}
				await forwarding?.close()
				holders.delete(owner)
			}
			try {
				const deadline = new OperationDeadline(
					timeout,
					'local Pal computer startup',
					request.signal,
				)
				const connected = await deadline.run(async (signal) => {
					engine = await prepare(signal)
					const occupied = await engine.run(
						['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'],
						{ signal },
					)
					if (occupied.trim())
						throw new Error(
							'An earlier Pal computer allocation still exists; stop it explicitly before reconnecting',
						)
					await engine.run(
						[
							'volume',
							'create',
							...(options.engine === 'podman' ? ['--ignore'] : []),
							'--label',
							`${OWNER_LABEL}=${owner}`,
							volume,
						],
						{ signal },
					)
					const volumes = JSON.parse(
						await engine.run(['volume', 'inspect', volume], { signal }),
					) as { Labels?: Record<string, string> }[]
					if (volumes[0]?.Labels?.[OWNER_LABEL] !== owner)
						throw new Error('The Pal data volume belongs to a different owner')
					runAttempted = true
					const started = await engine.run(
						[
							'run',
							'--detach',
							'--pull=never',
							// WSL machines can lack delegated cgroup controllers.
							// This adapter provides no per-container resource quotas.
							...(options.engine === 'podman' ? ['--cgroups=disabled'] : []),
							'--name',
							name,
							'--label',
							`${OWNER_LABEL}=${owner}`,
							'--label',
							`org.namzu.pal.generation=${leaseGeneration}`,
							'--label',
							`org.namzu.pal.allocation=${allocationId}`,
							'--user',
							'1001:1001',
							'--cap-drop=ALL',
							'--security-opt=no-new-privileges',
							'--read-only',
							'--ipc=private',
							'--network=bridge',
							'--shm-size=256m',
							'--tmpfs',
							'/tmp:rw,nosuid,nodev,size=512m,mode=1777',
							'--tmpfs',
							'/run:rw,nosuid,nodev,size=16m,mode=1777',
							'--mount',
							`type=volume,source=${volume},target=/home/namzu`,
							'--publish',
							'127.0.0.1::2024',
							'--publish',
							'127.0.0.1::2025',
							'--env',
							`NAMZU_SANDBOX_SCREEN_WIDTH=${width}`,
							'--env',
							`NAMZU_SANDBOX_SCREEN_HEIGHT=${height}`,
							'--env',
							'NAMZU_SANDBOX_TOKEN',
							image,
						],
						{ signal, env: { NAMZU_SANDBOX_TOKEN: token } },
					)
					created = true
					containerId = started.trim()
					if (!/^[0-9a-f]{64}$/.test(containerId))
						throw new Error('The Pal computer engine did not return a valid allocation identifier')
					const ports = JSON.parse(
						await engine.run(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name], {
							signal,
						}),
					) as Record<string, { HostIp?: string; HostPort?: string }[]>
					const guestPorts = [portFor(ports, 2024), portFor(ports, 2025)]
					forwarding = await engine.forwardPorts?.(guestPorts, {
						signal,
						onLost() {
							void clients?.sandbox.destroy().catch(() => {
								// Destroy fences calls first; its retained lease can retry recovery.
							})
						},
					})
					const localPorts = forwarding?.ports ?? guestPorts
					const executionUrl = `http://127.0.0.1:${localPorts[0]}`
					const desktopUrl = `http://127.0.0.1:${localPorts[1]}`
					for (;;) {
						signal.throwIfAborted()
						forwarding?.assertAlive()
						try {
							const response = await fetch(`${desktopUrl}/readyz`, {
								headers: { authorization: `Bearer ${token}` },
								signal,
							})
							const desktop = response.ok
								? ((await response.json()) as {
										protocol?: number
										width?: number
										height?: number
										browserReady?: boolean
										stream?: { protocol?: unknown }
									})
								: undefined
							const execution = await fetch(`${executionUrl}/healthz`, { signal })
							const worker = execution.ok
								? ((await execution.json()) as { protocolVersion?: number })
								: undefined
							if (
								desktop?.protocol === 1 &&
								desktop.width === width &&
								desktop.height === height &&
								desktop.browserReady === true &&
								worker?.protocolVersion === 2
							)
								return {
									executionUrl,
									desktopUrl,
									screenStream: desktop.stream?.protocol === 'rfb',
								}
						} catch {
							signal.throwIfAborted()
						}
						await new Promise<void>((resolve, reject) => {
							const timer = setTimeout(() => {
								signal.removeEventListener('abort', abort)
								resolve()
							}, 200)
							const abort = () => {
								clearTimeout(timer)
								reject(signal.reason)
							}
							signal.addEventListener('abort', abort, { once: true })
						})
					}
				})
				request.signal?.throwIfAborted()
				clients = localComputerClients({
					...connected,
					token,
					geometry: { width, height, scaleFactor: 1 },
					stop,
				})
				const admitted = clients
				return {
					palId: request.pal.id,
					environmentId,
					generation: leaseGeneration,
					...admitted,
					release: () => admitted.sandbox.destroy(),
				}
			} catch (error) {
				if (error instanceof LocalForwardCleanupError) forwarding = error.forward
				if (runAttempted && engine) {
					const ownedEngine = engine
					const cleanup = async (signal?: AbortSignal) => {
						// Reconcile an unacknowledged start by this attempt's unique
						// label, never by a name another process may have acquired.
						const owned = await ownedEngine.run(
							[
								'ps',
								'--all',
								'--filter',
								`label=org.namzu.pal.allocation=${allocationId}`,
								'--no-trunc',
								'--format',
								'{{.ID}}',
							],
							{ signal },
						)
						for (const id of owned.trim().split(/\s+/).filter(Boolean)) {
							if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid owned allocation identifier')
							await ownedEngine.run(['rm', '-f', id], { signal })
						}
						created = false
						await forwarding?.close()
					}
					try {
						await new OperationDeadline(timeout, 'local Pal computer cleanup').run(
							async (signal) => await cleanup(signal),
						)
					} catch {
						pendingCleanup.set(owner, cleanup)
						throw new Error(
							'Pal computer startup failed and cleanup could not be confirmed; the owned allocation requires operator recovery',
							{ cause: error },
						)
					}
				}
				holders.delete(owner)
				throw error
			}
		},
	}
}
