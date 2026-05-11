/**
 * Azure Container Instances Standby Pool backend.
 *
 * Sibling of `docker/` — same {@link SandboxBackend} surface, same
 * worker-HTTP contract, different shipping mechanism. Where docker
 * `docker run`s a container on a local daemon, this backend PUTs an
 * `Microsoft.ContainerInstance/containerGroups` resource that
 * references a pre-warmed `Microsoft.StandbyPool/standbyContainerGroupPools`
 * resource — Azure hands back a warm ACI in ~1.5 s instead of a
 * cold 10-30 s spawn. Refill is automatic per the pool's
 * `refillPolicy`.
 *
 * Workspace shipping:
 *  - Docker uses bind-mounts (`hostDir` source variant).
 *  - ACI has no host filesystem; this backend ONLY accepts
 *    `azureFileShare` source variants and translates them to ACI's
 *    `properties.volumes[] + container.properties.volumeMounts[]`
 *    shape. The Vandal-side (or any host) provisions per-task
 *    shares upstream and hands them in via the layout.
 *
 * Authentication:
 *  - Caller supplies a `getArmToken()` async function. Sandbox
 *    keeps zero auth dependencies (`@azure/identity` etc.) — the
 *    consumer's runtime owns Managed-Identity / AzureCLI / federated
 *    credential picking. Token is fetched on every ARM call so a
 *    short-lived token survives a long-running sandbox.
 *
 * Trust model:
 *  - ACI runs the container in a Microsoft-owned isolation host;
 *    inside, the worker is a non-root user (image's `USER namzu`).
 *  - The container group can be subnet-injected (no public IP) when
 *    `subnetId` is supplied. Without it the IP is public — fine for
 *    benchmarking, NOT acceptable for production. Caller decides.
 *  - The Confidential variant of Standby Pools (AMD SEV-SNP TEE) is
 *    a pool-side knob, not a backend knob — the backend never
 *    chooses; it just PUTs against whichever pool the caller named.
 */

import type {
	ContainerSandboxMountSource,
	ResolvedContainerSandboxLayout,
	Sandbox,
	SandboxEnvironment,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxId,
	SandboxStatus,
} from '@namzu/sdk'

import type { SandboxBackend, SandboxBackendOptions } from '../../index.js'

/**
 * Authentication callback. Caller returns a fresh Azure Resource
 * Manager bearer token (audience `https://management.azure.com/`).
 * Backend invokes this on every ARM call so a long-running sandbox
 * survives token rotation.
 */
export type ArmTokenProvider = () => Promise<string>

export interface ACIStandbyPoolBackendInternalConfig {
	readonly subscriptionId: string
	readonly resourceGroup: string
	readonly location: string
	/**
	 * Fully-qualified resource ID of the Standby Pool to claim from.
	 * Example:
	 *   /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.StandbyPool/standbyContainerGroupPools/<pool>
	 */
	readonly standbyPoolResourceId: string
	/**
	 * Fully-qualified resource ID of the Container Group Profile the
	 * pool was created against.
	 */
	readonly containerGroupProfileResourceId: string
	/**
	 * Container Group Profile revision the pool's warm instances were
	 * built from. Defaults to 1.
	 */
	readonly containerGroupProfileRevision?: number
	/**
	 * Pre-resolved layout. The backend requires every mount source to
	 * be `azureFileShare`; any other variant throws.
	 */
	readonly layout: ResolvedContainerSandboxLayout
	/**
	 * Authentication callback (see {@link ArmTokenProvider}).
	 */
	readonly getArmToken: ArmTokenProvider
	/**
	 * Optional subnet to inject the container group into (no public IP).
	 * Strongly recommended for production. When omitted, ACI assigns a
	 * public IP — fine for benchmarks, attack-surface for prod.
	 */
	readonly subnetId?: string
	readonly readyPollIntervalMs?: number
	readonly readyTimeoutMs?: number
	/**
	 * Worker HTTP port (matches the image's listening port). Default 2024.
	 */
	readonly workerPort?: number
	readonly armApiVersion?: string
}

const DEFAULT_READY_POLL_MS = 500
const DEFAULT_READY_TIMEOUT_MS = 60_000
const DEFAULT_WORKER_PORT = 2024
const DEFAULT_ARM_API_VERSION = '2024-05-01-preview'
const ARM_BASE = 'https://management.azure.com'

/**
 * Build a {@link SandboxBackend} backed by Azure Container Instances
 * Standby Pool. Construction is synchronous; the ARM PUT happens on
 * the first `create()`.
 */
export function buildAciStandbyPoolBackend(
	config: ACIStandbyPoolBackendInternalConfig,
): SandboxBackend {
	return {
		tier: 'container',
		name: 'aci-standby-pool',
		async create(options: SandboxBackendOptions): Promise<Sandbox> {
			return await spawnAciSandbox(config, options)
		},
	}
}

interface AzureFileShareSource {
	readonly storageAccountName: string
	readonly shareName: string
	readonly storageAccountKey: string
}

/**
 * Interpret one mount source. ACI accepts two source variants:
 *   - `azureFileShare` → emit an ACI `volume.azureFile` + matching `volumeMount`.
 *   - `inImage` → emit NOTHING; the container's own filesystem carries the path.
 *
 * Standby-Pool-warm flows MUST use `inImage` because Standby Pool's
 * claim-time API rejects every `volumes[]` override (the volume set
 * is profile-baked across all warm instances). Cold-spawn ACI flows
 * can use either.
 *
 * The `hostDir` variant is for docker backends and is rejected here.
 */
function interpretSource(
	source: ContainerSandboxMountSource,
	label: string,
):
	| { kind: 'azureFile'; source: AzureFileShareSource }
	| { kind: 'inImage' } {
	if (source.type === 'azureFileShare') {
		return {
			kind: 'azureFile',
			source: {
				storageAccountName: source.storageAccountName,
				shareName: source.shareName,
				storageAccountKey: source.storageAccountKey,
			},
		}
	}
	if (source.type === 'inImage') {
		return { kind: 'inImage' }
	}
	throw new Error(
		`aci-standby-pool backend cannot consume mount source type ${JSON.stringify(source.type)} for ${label}; ` +
			`expected 'azureFileShare' or 'inImage'. The hostDir variant belongs to the docker backend.`,
	)
}

interface BuiltVolumes {
	readonly volumes: Array<{
		name: string
		azureFile: {
			shareName: string
			storageAccountName: string
			storageAccountKey: string
			readOnly: boolean
		}
	}>
	readonly volumeMounts: Array<{
		name: string
		mountPath: string
		readOnly: boolean
	}>
}

function buildAzureFileVolumesFromLayout(
	layout: ResolvedContainerSandboxLayout,
): BuiltVolumes {
	const volumes: BuiltVolumes['volumes'] = []
	const volumeMounts: BuiltVolumes['volumeMounts'] = []
	let counter = 0

	function add(
		mount: { readonly source: ContainerSandboxMountSource; readonly containerPath: string },
		label: string,
		readOnly: boolean,
	): void {
		const interpreted = interpretSource(mount.source, label)
		// `inImage` is a no-op — the image's own filesystem provides
		// the path. The Standby-Pool-warm flow lives on this branch.
		if (interpreted.kind === 'inImage') return
		const source = interpreted.source
		const name = `vol-${label}-${counter++}`
		volumes.push({
			name,
			azureFile: {
				shareName: source.shareName,
				storageAccountName: source.storageAccountName,
				storageAccountKey: source.storageAccountKey,
				readOnly,
			},
		})
		volumeMounts.push({
			name,
			mountPath: mount.containerPath,
			readOnly,
		})
	}

	add(layout.outputs, 'outputs', false)
	if (layout.uploads) add(layout.uploads, 'uploads', true)
	if (layout.scratch) add(layout.scratch, 'scratch', false)
	if (layout.toolResults) add(layout.toolResults, 'toolResults', true)
	if (layout.transcripts) add(layout.transcripts, 'transcripts', true)
	if (layout.skills) {
		for (const skill of layout.skills) {
			add(
				{ source: skill.source, containerPath: skill.containerPath },
				`skill-${skill.id}`,
				true,
			)
		}
	}

	return { volumes, volumeMounts }
}

function detectEnvironment(): SandboxEnvironment {
	// ACI containers run Linux. The SandboxEnvironment enum is host-
	// platform shape, not container internals — we pick the variant
	// the consumer's code paths expect for a Linux namespace-isolated
	// worker.
	return 'linux-namespace'
}

let _sandboxIdCounter = 0
function generateSandboxId(): SandboxId {
	const ts = Date.now().toString(36)
	const rand = Math.random().toString(36).slice(2, 8)
	_sandboxIdCounter += 1
	return `sbx_${ts}_${rand}_${_sandboxIdCounter}` as SandboxId
}

async function armCall<T>(
	url: string,
	method: 'GET' | 'PUT' | 'DELETE',
	getToken: ArmTokenProvider,
	body?: unknown,
): Promise<T | undefined> {
	const token = await getToken()
	const init: RequestInit = {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
	}
	if (body !== undefined) {
		init.body = JSON.stringify(body)
	}
	const res = await fetch(url, init)
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`ARM ${method} ${url} → ${res.status}: ${text}`)
	}
	if (res.status === 204 || res.status === 202) return undefined
	const ct = res.headers.get('content-type') ?? ''
	if (ct.includes('application/json')) {
		return (await res.json()) as T
	}
	return undefined
}

interface ArmContainerGroup {
	id?: string
	name?: string
	properties?: {
		provisioningState?: string
		ipAddress?: {
			ip?: string
			fqdn?: string
		}
	}
}

async function spawnAciSandbox(
	config: ACIStandbyPoolBackendInternalConfig,
	_options: SandboxBackendOptions,
): Promise<Sandbox> {
	const id = generateSandboxId()
	const cgName = `vandal-task-${id.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 50)}`
	const apiVersion = config.armApiVersion ?? DEFAULT_ARM_API_VERSION
	const workerPort = config.workerPort ?? DEFAULT_WORKER_PORT
	const armUrl = `${ARM_BASE}/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}/providers/Microsoft.ContainerInstance/containerGroups/${cgName}?api-version=${apiVersion}`

	const { volumes, volumeMounts } = buildAzureFileVolumesFromLayout(config.layout)

	// Standby Pool's claim API rejects every property override that
	// is NOT a `configMap`. The empty / no-mount cases (every source
	// is `inImage`) MUST therefore omit `containers`, `volumes`, and
	// `volumeMounts` entirely from the PUT body — even an empty
	// array trips the BadRequest "ContainerGroup properties other
	// than config map are not allowed" check. The fields land only
	// when something real needs to ride through (e.g. cold-spawn ACI
	// with per-task azureFileShare mounts, future flow).
	const properties: Record<string, unknown> = {
		containerGroupProfile: {
			id: config.containerGroupProfileResourceId,
			revision: config.containerGroupProfileRevision ?? 1,
		},
		standbyPoolProfile: {
			id: config.standbyPoolResourceId,
		},
		...(config.subnetId ? { subnetIds: [{ id: config.subnetId }] } : {}),
	}
	if (volumes.length > 0) {
		properties.volumes = volumes
		properties.containers = [
			{
				name: 'vandal-task-worker',
				properties: { volumeMounts },
			},
		]
	}

	const body: Record<string, unknown> = {
		location: config.location,
		properties,
	}

	let claimed: ArmContainerGroup | undefined
	try {
		claimed = await armCall<ArmContainerGroup>(armUrl, 'PUT', config.getArmToken, body)
	} catch (err) {
		throw new Error(
			`aci-standby-pool: failed to claim from pool — ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	const initialIp = claimed?.properties?.ipAddress?.ip
	let ip = initialIp
	if (!ip) {
		ip = await pollForRunningIp(
			armUrl,
			config.getArmToken,
			config.readyPollIntervalMs ?? DEFAULT_READY_POLL_MS,
			config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
		)
	}

	const baseUrl = `http://${ip}:${workerPort}`
	await waitForWorkerReady(
		baseUrl,
		config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
		config.readyPollIntervalMs ?? DEFAULT_READY_POLL_MS,
	)

	let status: SandboxStatus = 'ready'
	const rootDir = config.layout.outputs.containerPath

	return {
		id,
		get status(): SandboxStatus {
			return status
		},
		rootDir,
		environment: detectEnvironment(),

		async exec(
			command: string,
			argv?: string[],
			opts?: SandboxExecOptions,
		): Promise<SandboxExecResult> {
			status = 'busy'
			try {
				return await execViaWorker(baseUrl, command, argv, opts)
			} finally {
				status = 'ready'
			}
		},

		async writeFile(path: string, content: string | Buffer): Promise<void> {
			const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
			const res = await fetch(`${baseUrl}/write-file`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					path,
					content: buf.toString('base64'),
					encoding: 'base64',
				}),
			})
			if (!res.ok) {
				throw new Error(`write-file failed: HTTP ${res.status} ${await res.text()}`)
			}
		},

		async readFile(path: string): Promise<Buffer> {
			const res = await fetch(`${baseUrl}/read-file`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path, encoding: 'base64' }),
			})
			if (!res.ok) {
				throw new Error(`read-file failed: HTTP ${res.status} ${await res.text()}`)
			}
			const json = (await res.json()) as { ok: boolean; content?: string; error?: string }
			if (!json.ok || typeof json.content !== 'string') {
				throw new Error(json.error ?? 'read-file: no content')
			}
			return Buffer.from(json.content, 'base64')
		},

		async destroy(): Promise<void> {
			status = 'destroyed'
			try {
				await armCall(armUrl, 'DELETE', config.getArmToken)
			} catch {
				// Best-effort. Pool refill keeps the pool topped up.
			}
		},
	}
}

async function pollForRunningIp(
	armUrl: string,
	getToken: ArmTokenProvider,
	pollIntervalMs: number,
	timeoutMs: number,
): Promise<string> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const cg = await armCall<ArmContainerGroup>(armUrl, 'GET', getToken)
		const state = cg?.properties?.provisioningState
		const ip = cg?.properties?.ipAddress?.ip
		if (state === 'Succeeded' && ip) return ip
		if (state === 'Failed') {
			throw new Error(`aci-standby-pool: container group provisioning failed`)
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs))
	}
	throw new Error(`aci-standby-pool: timed out waiting for container group IP (${timeoutMs}ms)`)
}

async function waitForWorkerReady(
	baseUrl: string,
	timeoutMs: number,
	pollIntervalMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/healthz`, {
				signal: AbortSignal.timeout(2000),
			})
			if (res.ok) return
		} catch {
			// Network not ready yet, try again.
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs))
	}
	throw new Error(`aci-standby-pool: worker /healthz never responded (${timeoutMs}ms)`)
}

async function execViaWorker(
	baseUrl: string,
	command: string,
	argv: string[] | undefined,
	opts: SandboxExecOptions | undefined,
): Promise<SandboxExecResult> {
	const start = Date.now()
	const res = await fetch(`${baseUrl}/execute`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			command,
			args: argv ?? [],
			cwd: opts?.cwd,
			env: opts?.env,
			timeoutMs: opts?.timeout,
		}),
	})
	if (!res.ok || !res.body) {
		throw new Error(`execute failed: HTTP ${res.status} ${await res.text()}`)
	}

	let stdout = ''
	let stderr = ''
	let exitCode = -1
	let timedOut = false

	const decoder = new TextDecoder()
	const reader = res.body.getReader()
	let buffered = ''
	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		buffered += decoder.decode(value, { stream: true })
		let newlineIdx = buffered.indexOf('\n')
		while (newlineIdx !== -1) {
			const line = buffered.slice(0, newlineIdx).trim()
			buffered = buffered.slice(newlineIdx + 1)
			if (line) {
				try {
					const event = JSON.parse(line) as
						| { type: 'stdout_delta'; data: string }
						| { type: 'stderr_delta'; data: string }
						| { type: 'result'; exitCode: number; timedOut: boolean }
						| { type: 'error'; error: string }
					if (event.type === 'stdout_delta') stdout += event.data
					else if (event.type === 'stderr_delta') stderr += event.data
					else if (event.type === 'result') {
						exitCode = event.exitCode
						timedOut = event.timedOut
					} else if (event.type === 'error') {
						throw new Error(event.error)
					}
				} catch (err) {
					if (!(err instanceof SyntaxError)) throw err
				}
			}
			newlineIdx = buffered.indexOf('\n')
		}
	}

	return {
		stdout,
		stderr,
		exitCode,
		timedOut,
		durationMs: Date.now() - start,
	} as SandboxExecResult
}
