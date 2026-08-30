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
 *    `subnetId` is supplied. Without it the address is public — fine for
 *    benchmarking, NOT acceptable for production. The caller decides,
 *    but has to say so: with neither `subnetId` nor `allowPublicAddress`
 *    the backend refuses to claim. This line used to end "Caller
 *    decides", and nothing asked them — omitting a field they had never
 *    heard of chose the public address silently.
 *  - The Confidential variant of Standby Pools (AMD SEV-SNP TEE) is
 *    a pool-side knob, not a backend knob — the backend never
 *    chooses; it just PUTs against whichever pool the caller named.
 */

import type {
	ContainerSandboxMountSource,
	ResolvedContainerSandboxLayout,
	Sandbox,
	SandboxDestroyOptions,
	SandboxEnvironment,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxFileEntry,
	SandboxId,
	SandboxStatus,
} from '@namzu/sdk'
import { asSandboxId } from '@namzu/sdk'

import type { SandboxBackend, SandboxBackendOptions } from '../../index.js'
import { HttpWorkerClient } from '../http-worker-client.js'
import {
	OperationDeadline,
	OperationDeadlineExpired,
	probeHttpHealth,
	resolveReadinessOptions,
	runFailureCleanup,
} from '../readiness.js'
import { RemoteCancellationUnknownError } from '../remote-execution-controller.js'

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
	 * Subnet to inject the container group into, so it has no public
	 * address. Omitting it means the platform assigns a public one, which
	 * the backend now refuses unless {@link allowPublicAddress} says
	 * otherwise — so this is optional in the type and required in practice
	 * for anything but a benchmark.
	 */
	readonly subnetId?: string
	/**
	 * Claim a container group on a public address anyway, with no subnet.
	 *
	 * Off by default, and the default is the whole point. The worker this
	 * backend dials has no authentication of any kind — its own docblock
	 * says so — so a public address puts an unauthenticated control API on
	 * the internet. That is a fine trade for a benchmark and never for
	 * production, and the difference between the two is a decision an
	 * operator makes rather than one a missing field makes for them.
	 *
	 * Named for what it grants rather than what it disables: an operator
	 * reading `allowPublicAddress: true` in a config review knows what they
	 * are looking at.
	 */
	readonly allowPublicAddress?: boolean
	readonly readyPollIntervalMs?: number
	readonly readyTimeoutMs?: number
	/**
	 * Worker HTTP port (matches the image's listening port). Default 2024.
	 */
	readonly workerPort?: number
	readonly armApiVersion?: string
	/**
	 * Prefix for the ACI container group name and the inner worker
	 * container. Defaults to a Namzu-branded label; consumers (e.g.
	 * Vandal) override via env / config to brand their own
	 * deployments. The runtime appends a sandbox id suffix; the
	 * combined name is sanitised to ARM's allowed character set.
	 */
	readonly containerNamePrefix?: string
}

const DEFAULT_READY_POLL_MS = 500
const DEFAULT_READY_TIMEOUT_MS = 60_000
const DEFAULT_WORKER_PORT = 2024
const DEFAULT_ARM_API_VERSION = '2024-05-01-preview'
const ARM_BASE = 'https://management.azure.com'
const DEFAULT_CONTAINER_NAME_PREFIX = 'namzu-task'

/**
 * Build a {@link SandboxBackend} backed by Azure Container Instances
 * Standby Pool. Construction is synchronous; the ARM PUT happens on
 * the first `create()`.
 */
export function buildAciStandbyPoolBackend(
	config: ACIStandbyPoolBackendInternalConfig,
): SandboxBackend {
	const readiness = resolveReadinessOptions(
		'aci-standby-pool',
		config.readyTimeoutMs,
		config.readyPollIntervalMs,
		{
			timeoutMs: DEFAULT_READY_TIMEOUT_MS,
			pollIntervalMs: DEFAULT_READY_POLL_MS,
		},
	)
	return {
		tier: 'container',
		name: 'aci-standby-pool',
		async create(options: SandboxBackendOptions): Promise<Sandbox> {
			return await spawnAciSandbox(config, options, readiness)
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
): { kind: 'azureFile'; source: AzureFileShareSource } | { kind: 'inImage' } {
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
		`aci-standby-pool backend cannot consume mount source type ${JSON.stringify(source.type)} for ${label}; expected 'azureFileShare' or 'inImage'. The hostDir variant belongs to the docker backend.`,
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

function buildAzureFileVolumesFromLayout(layout: ResolvedContainerSandboxLayout): BuiltVolumes {
	const volumes: BuiltVolumes['volumes'] = []
	const volumeMounts: BuiltVolumes['volumeMounts'] = []
	let counter = 0

	function add(
		mount: {
			readonly source: ContainerSandboxMountSource
			readonly containerPath: string
		},
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
			add({ source: skill.source, containerPath: skill.containerPath }, `skill-${skill.id}`, true)
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
	return asSandboxId(`sbx_${ts}_${rand}_${_sandboxIdCounter}`)
}

async function armCall<T>(
	url: string,
	method: 'GET' | 'PUT' | 'DELETE',
	getToken: ArmTokenProvider,
	body?: unknown,
	signal?: AbortSignal,
	acceptedStatuses: readonly number[] = [],
): Promise<T | undefined> {
	signal?.throwIfAborted()
	const token = await getToken()
	signal?.throwIfAborted()
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
	if (signal !== undefined) init.signal = signal
	const res = await fetch(url, init)
	signal?.throwIfAborted()
	if (!res.ok) {
		if (acceptedStatuses.includes(res.status)) {
			await res.text()
			signal?.throwIfAborted()
			return undefined
		}
		const text = await res.text()
		signal?.throwIfAborted()
		throw new Error(`ARM ${method} ${url} → ${res.status}: ${text}`)
	}
	if (res.status === 204 || res.status === 202) return undefined
	const ct = res.headers.get('content-type') ?? ''
	if (ct.includes('application/json')) {
		const json = (await res.json()) as T
		signal?.throwIfAborted()
		return json
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

/**
 * Per-sandbox controls this backend cannot express, and must therefore
 * refuse rather than accept.
 *
 * The claim API rejects every property override that is not a config map
 * (see the note in `spawnAciSandbox`), so a memory cap, a process cap,
 * environment variables and an egress policy have nowhere to ride through.
 * They were accepted and dropped: a host that asked for `deny-all` and
 * 512 MB got full outbound network and no cap, with no error and no
 * warning — from the same call shape that IS enforced on the sibling
 * container backend. Switching backends silently removed the
 * blast-radius controls, which is the worst way to lose them.
 *
 * Refusing is the honest fix rather than a missing feature: the limits are
 * a property of the pooled profile, so the answer is to configure them
 * there, not to pretend they can be set per claim.
 */
const UNSUPPORTED_PER_SANDBOX_CONTROLS = [
	['egress', 'network egress policy'],
	['memoryLimitMb', 'memory limit'],
	['maxProcesses', 'process limit'],
	['env', 'environment variables'],
] as const

export function assertEnforceable(options: SandboxBackendOptions): void {
	const unenforceable = UNSUPPORTED_PER_SANDBOX_CONTROLS.filter(([key]) => {
		const value = options[key]
		return value !== undefined && (key !== 'env' || Object.keys(value).length > 0)
	})
	if (unenforceable.length === 0) return

	throw new Error(
		`The standby-pool sandbox backend cannot enforce per-sandbox ${unenforceable
			.map(([, label]) => label)
			.join(
				', ',
			)}: the pool's claim API rejects every property override except a config map, so these would be accepted and silently dropped. Set them on the container group profile the pool is built from, or use a backend that applies them per sandbox. Refusing rather than silently granting more than was asked for.`,
	)
}

/**
 * Refuse to claim a container group that will answer on a public address.
 *
 * The sibling above refuses controls this backend cannot enforce. This
 * refuses one it *can* enforce and would otherwise skip by omission —
 * which is the more dangerous shape, because nothing is being dropped and
 * so nothing looks wrong. A caller who never heard of `subnetId` gets a
 * working sandbox on the internet and no signal at all.
 *
 * What is on that address matters: `worker/server.js` states "Authn: none"
 * in its own docblock and binds every interface. Inside a private network
 * that is the boundary doing the work. With a public address there is no
 * boundary left, and the worker's `/execute` is reachable by anyone.
 *
 * Defaulting to refusal rather than to a warning, because a warning on a
 * path that otherwise succeeds is read once and never again.
 */
export function assertNotPubliclyAddressed(config: {
	subnetId?: string
	allowPublicAddress?: boolean
}): void {
	if (config.subnetId) return
	if (config.allowPublicAddress) return

	throw new Error(
		'The standby-pool sandbox backend will not claim a container group without `subnetId`: with no subnet the platform assigns a public address, and the worker on it has no authentication of any kind, so its execute endpoint would be reachable from the internet. Supply `subnetId` to inject the group into a private network, or set `allowPublicAddress: true` if this is a benchmark and you mean it.',
	)
}

async function spawnAciSandbox(
	config: ACIStandbyPoolBackendInternalConfig,
	options: SandboxBackendOptions,
	readiness: { readonly timeoutMs: number; readonly pollIntervalMs: number },
): Promise<Sandbox> {
	options.signal?.throwIfAborted()
	assertEnforceable(options)
	assertNotPubliclyAddressed(config)
	const id = generateSandboxId()
	const prefix = config.containerNamePrefix ?? DEFAULT_CONTAINER_NAME_PREFIX
	const cgName = `${prefix}-${id
		.replace(/[^a-z0-9-]/gi, '')
		.toLowerCase()
		.slice(0, 50)}`
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
				name: `${prefix}-worker`,
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
		claimed = await armCall<ArmContainerGroup>(
			armUrl,
			'PUT',
			config.getArmToken,
			body,
			options.signal,
		)
	} catch (err) {
		// The resource name is client-owned even when ARM never returns the
		// claim response. Best-effort reconciliation is therefore possible.
		// ARM still owns the create/delete ordering semantics; a resource that
		// commits after this DELETE needs the deployment's normal resource reaper.
		if (options.signal?.aborted) {
			await runFailureCleanup(async (signal) => {
				await armCall(armUrl, 'DELETE', config.getArmToken, undefined, signal)
			})
		}
		throw new Error(
			`aci-standby-pool: failed to claim from pool — ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	const initialIp = claimed?.properties?.ipAddress?.ip
	let ip = initialIp
	const readinessDeadline = new OperationDeadline(
		readiness.timeoutMs,
		'aci-standby-pool readiness',
		options.signal,
	)
	try {
		if (!ip) {
			ip = await pollForRunningIp(
				armUrl,
				config.getArmToken,
				readinessDeadline,
				readiness.pollIntervalMs,
				readiness.timeoutMs,
			)
		}

		const baseUrl = `http://${ip}:${workerPort}`
		await waitForWorkerReady(
			baseUrl,
			readinessDeadline,
			readiness.timeoutMs,
			readiness.pollIntervalMs,
		)

		type Lifecycle = 'active' | 'retiring' | 'destroyed'
		let activeExecutions = 0
		let lifecycle: Lifecycle = 'active'
		let retirementPromise:
			| Promise<{ readonly accepted: boolean; readonly error?: Error }>
			| undefined
		let teardownPromise: Promise<void> | undefined
		let teardownComplete = false
		const rootDir = config.layout.outputs.containerPath
		const workerClient = new HttpWorkerClient(baseUrl)
		const assertActive = (): void => {
			if (lifecycle !== 'active') {
				throw new Error(`Sandbox ${id} is ${lifecycle}; no new worker operation can be admitted`)
			}
		}
		const teardownSandbox = (signal?: AbortSignal): Promise<void> => {
			lifecycle = 'retiring'
			if (teardownComplete) return Promise.resolve()
			if (teardownPromise) return teardownPromise
			const attempt = armCall(
				armUrl,
				'DELETE',
				config.getArmToken,
				undefined,
				signal,
				[404, 410],
			).then(() => undefined)
			const shared = attempt.then(
				() => {
					teardownComplete = true
					lifecycle = 'destroyed'
				},
				(error: unknown) => {
					if (teardownPromise === shared) teardownPromise = undefined
					throw error
				},
			)
			teardownPromise = shared
			return shared
		}
		const retire = (): Promise<{
			readonly accepted: boolean
			readonly error?: Error
		}> => {
			lifecycle = 'retiring'
			if (retirementPromise) return retirementPromise
			const deadline = new OperationDeadline(5_000, `ACI sandbox ${id} retirement`)
			retirementPromise = deadline
				.run(async (signal) => {
					const joinedExistingAttempt = teardownPromise !== undefined
					try {
						await teardownSandbox(signal)
					} catch (error) {
						if (!joinedExistingAttempt || signal.aborted) throw error
						await teardownSandbox(signal)
					}
				})
				.then(() => {
					return { accepted: true as const }
				})
				.catch((error: unknown) => ({
					accepted: false as const,
					error: error instanceof Error ? error : new Error(String(error)),
				}))
			return retirementPromise
		}
		const runExecution = async <T>(operation: () => Promise<T>): Promise<T> => {
			assertActive()
			activeExecutions += 1
			try {
				return await operation()
			} catch (error) {
				if (error instanceof RemoteCancellationUnknownError) {
					error.retirement = await retire()
				}
				throw error
			} finally {
				activeExecutions = Math.max(0, activeExecutions - 1)
			}
		}

		return {
			id,
			get status(): SandboxStatus {
				if (lifecycle !== 'active') return 'destroyed'
				return activeExecutions > 0 ? 'busy' : 'ready'
			},
			rootDir,
			environment: detectEnvironment(),

			async exec(
				command: string,
				argv?: string[],
				opts?: SandboxExecOptions,
			): Promise<SandboxExecResult> {
				return await runExecution(async () => await workerClient.exec(command, argv, opts))
			},

			async writeFile(path: string, content: string | Buffer): Promise<void> {
				assertActive()
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
				assertActive()
				const res = await fetch(`${baseUrl}/read-file`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ path, encoding: 'base64' }),
				})
				if (!res.ok) {
					throw new Error(`read-file failed: HTTP ${res.status} ${await res.text()}`)
				}
				const json = (await res.json()) as {
					ok: boolean
					content?: string
					error?: string
				}
				if (!json.ok || typeof json.content !== 'string') {
					throw new Error(json.error ?? 'read-file: no content')
				}
				return Buffer.from(json.content, 'base64')
			},

			async listFiles(rootPath: string): Promise<readonly SandboxFileEntry[]> {
				return await runExecution(async () => await listFilesViaWorker(workerClient, rootPath))
			},

			async destroy(options?: SandboxDestroyOptions): Promise<void> {
				if (retirementPromise) {
					const observation = await retirementPromise
					if (observation.accepted) return
					retirementPromise = undefined
				}
				// ARM DELETE — let failures propagate. The Vandal-side
				// lifecycle wraps this in its own try/catch with logging,
				// so a silently swallowed error here means orphan ACI
				// container groups pile up under the resource group with
				// no observability handle. The Standby Pool's refill keeps
				// the WARM side topped up; that has nothing to do with
				// cleaning up a CLAIMED instance, which is exclusively the
				// claimer's responsibility.
				await teardownSandbox(options?.signal)
			},
		}
	} catch (err) {
		await runFailureCleanup(async (signal) => {
			await armCall(armUrl, 'DELETE', config.getArmToken, undefined, signal)
		})
		throw err
	}
}

async function pollForRunningIp(
	armUrl: string,
	getToken: ArmTokenProvider,
	deadline: OperationDeadline,
	pollIntervalMs: number,
	timeoutMs: number,
): Promise<string> {
	while (deadline.remainingMs() > 0) {
		let cg: ArmContainerGroup | undefined
		try {
			cg = await deadline.run((signal) =>
				armCall<ArmContainerGroup>(armUrl, 'GET', getToken, undefined, signal),
			)
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			throw err
		}
		const state = cg?.properties?.provisioningState
		const ip = cg?.properties?.ipAddress?.ip
		if (state === 'Succeeded' && ip) return ip
		if (state === 'Failed') {
			throw new Error('aci-standby-pool: container group provisioning failed')
		}
		try {
			await deadline.delay(pollIntervalMs)
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			throw err
		}
	}
	throw new Error(`aci-standby-pool: timed out waiting for container group IP (${timeoutMs}ms)`)
}

async function waitForWorkerReady(
	baseUrl: string,
	deadline: OperationDeadline,
	timeoutMs: number,
	pollIntervalMs: number,
): Promise<void> {
	while (deadline.remainingMs() > 0) {
		try {
			const result = await deadline.run((signal) => probeHttpHealth(`${baseUrl}/healthz`, signal))
			if (result.ok) return
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			// Network not ready yet, try again.
		}
		try {
			await deadline.delay(pollIntervalMs)
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			throw err
		}
	}
	throw new Error(`aci-standby-pool: worker /healthz never responded (${timeoutMs}ms)`)
}

/**
 * Recursively list regular files under `rootPath` by shelling out to
 * the worker's `find` (GNU find on the Debian-based reference image).
 * `-printf` emits one `<path>\t<size>` line per file; any other
 * non-zero exit (notably `find: '<root>': No such file or directory`)
 * is mapped to "empty listing" because the agent legitimately may not
 * have produced anything in `rootPath` yet.
 */
async function listFilesViaWorker(
	workerClient: HttpWorkerClient,
	rootPath: string,
): Promise<readonly SandboxFileEntry[]> {
	const result = await workerClient.exec(
		'find',
		[rootPath, '-type', 'f', '-printf', '%p\t%s\n'],
		undefined,
	)
	if (result.exitCode !== 0) {
		return []
	}
	const entries: SandboxFileEntry[] = []
	for (const rawLine of result.stdout.split('\n')) {
		if (!rawLine) continue
		const tab = rawLine.indexOf('\t')
		if (tab < 0) continue
		const path = rawLine.slice(0, tab)
		const size = Number.parseInt(rawLine.slice(tab + 1), 10)
		if (!path || !Number.isFinite(size)) continue
		entries.push({ path, size })
	}
	return entries
}
