/**
 * `microvm:self-hosted` (Firecracker) backend.
 *
 * Sibling of `docker/` and `aci-standby-pool/`: same
 * {@link SandboxBackend} surface, same NDJSON exec-stream + base64
 * file-IO **wire contract**, different transport and shipping
 * mechanism.
 *
 *  - docker `docker run`s a container and reaches an HTTP worker on a
 *    host loopback port.
 *  - aci PUTs an ACI container group and reaches the same HTTP worker
 *    over the group's IP.
 *  - firecracker POSTs the owned Azure **orchestrator** to CoW-resume a
 *    microVM off the golden snapshot, then reaches a **custom vsock
 *    agent** baked into the golden rootfs over the **vsock transport**
 *    (`transport.ts`). The wire FORMAT is identical (see `protocol.ts`);
 *    only the transport differs — HTTP for docker/aci, framed-over-vsock
 *    for FC, because across an FC snapshot resume a TCP control channel
 *    is dead-on-arrival while the vsock LISTEN socket survives
 *    (FC `snapshot-support.md`).
 *
 * ## Why this is a remote-copy backend (no host bind-mounts)
 * A sibling process on the FC host cannot see the microVM's
 * filesystem, so — exactly like ACI — the workspace is seeded by
 * archive-sync over the control channel (tar.gz `writeFile` +
 * in-sandbox `tar -xzf` via `exec`), driven by the Vandal-side
 * lifecycle (`workspace-sync.ts`). This backend therefore exposes no
 * `layout` mount rendering; it only needs the `outputs` container path
 * as the workspace root, which the orchestrator returns as `rootDir`.
 *
 * ## Trust model
 * The microVM is a hardware-virtualization (KVM) trust boundary —
 * stronger than docker namespaces or ACI's managed isolation. The
 * vsock control channel never traverses the guest's egress netns; the
 * agent listens on a fixed AF_VSOCK port captured warm in the golden
 * snapshot. Auth to the orchestrator rides a caller-supplied
 * `getToken()` closure (the ACI `getArmToken` pattern) so
 * `@namzu/sandbox` keeps zero Azure-SDK dependencies.
 *
 * ## Auth / SDK-dependency boundary
 * `getToken()` mirrors ACI's `getArmToken`: the consumer's runtime
 * owns Managed-Identity / federated-credential picking; this package
 * only calls the closure on every orchestrator HTTP call so a
 * long-running sandbox survives token rotation.
 */

import type {
	Sandbox,
	SandboxEnvironment,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxFileEntry,
	SandboxId,
	SandboxStatus,
} from '@namzu/sdk'

import type { SandboxBackend, SandboxBackendOptions } from '../../index.js'
import type { SandboxAgentHandle, VsockTransportOptions } from './transport.js'
import { VsockAgentTransport } from './transport.js'

/**
 * Async callback returning a fresh bearer token for
 * {@link FirecrackerBackendInternalConfig.orchestratorEndpoint}.
 * Invoked on every orchestrator HTTP call (mirrors ACI's
 * `ArmTokenProvider`).
 */
export type OrchestratorTokenProvider = () => Promise<string>

export interface FirecrackerBackendInternalConfig {
	/** Base URL of the owned Azure control plane / orchestrator. */
	readonly orchestratorEndpoint: string
	/** Bearer token provider for `orchestratorEndpoint`. */
	readonly getToken: OrchestratorTokenProvider
	/** Golden template / snapshot revision id to resume from. */
	readonly template?: string
	/** Fixed guest AF_VSOCK port the agent listens on (contract port). */
	readonly agentVsockPort?: number
	readonly readyTimeoutMs?: number
	readonly readyPollIntervalMs?: number
	/** Transport tuning forwarded to {@link VsockAgentTransport}. */
	readonly transport?: VsockTransportOptions
}

const DEFAULT_AGENT_VSOCK_PORT = 1024
const DEFAULT_READY_TIMEOUT_MS = 60_000
const DEFAULT_READY_POLL_MS = 250

/**
 * Build a {@link SandboxBackend} backed by the owned Firecracker
 * platform. Construction is synchronous; the orchestrator POST happens
 * on the first `create()`.
 */
export function buildFirecrackerBackend(config: FirecrackerBackendInternalConfig): SandboxBackend {
	return {
		tier: 'microvm',
		name: 'firecracker',
		async create(options: SandboxBackendOptions): Promise<Sandbox> {
			return await spawnFirecrackerSandbox(config, options)
		},
	}
}

// ---------------------------------------------------------------------------
// Orchestrator wire (the create/destroy control plane)
// ---------------------------------------------------------------------------

interface OrchestratorCreateRequest {
	readonly template?: string
	readonly memoryLimitMb?: number
	readonly maxProcesses?: number
	readonly timeoutMs?: number
	/**
	 * Resolved egress allowlist for the run, materialised by the host
	 * into per-VM nftables rules (deny-all default). The backend just
	 * forwards the resolved hostnames; it does not own the firewall.
	 */
	readonly egressAllowlist?: readonly string[]
}

/**
 * Orchestrator `create` response. Carries the sandbox id, the
 * addressable vsock endpoint (see {@link SandboxAgentHandle}), and the
 * workspace root path the agent resolves against.
 */
interface OrchestratorCreateResponse {
	readonly sandboxId: string
	readonly agent: SandboxAgentHandle
	readonly rootDir: string
}

async function orchestratorCall<T>(
	endpoint: string,
	pathSuffix: string,
	method: 'POST' | 'DELETE',
	getToken: OrchestratorTokenProvider,
	body?: unknown,
): Promise<T | undefined> {
	const token = await getToken()
	const url = `${endpoint.replace(/\/+$/, '')}${pathSuffix}`
	const init: RequestInit = {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
	}
	if (body !== undefined) init.body = JSON.stringify(body)
	let res: Response
	try {
		res = await fetch(url, init)
	} catch (err) {
		const cause = err instanceof Error ? err.cause : undefined
		throw new Error(
			`firecracker orchestrator ${method} ${url} failed: ${
				err instanceof Error ? err.message : String(err)
			}${cause ? ` — cause: ${cause instanceof Error ? cause.message : String(cause)}` : ''}`,
			{ cause: err },
		)
	}
	if (!res.ok) {
		throw new Error(
			`firecracker orchestrator ${method} ${url} → ${res.status}: ${await res.text()}`,
		)
	}
	if (res.status === 204) return undefined
	const ct = res.headers.get('content-type') ?? ''
	if (ct.includes('application/json')) return (await res.json()) as T
	return undefined
}

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

async function spawnFirecrackerSandbox(
	config: FirecrackerBackendInternalConfig,
	options: SandboxBackendOptions,
): Promise<Sandbox> {
	const endpoint = config.orchestratorEndpoint
	const createBody: OrchestratorCreateRequest = {
		...(config.template !== undefined ? { template: config.template } : {}),
		...(options.memoryLimitMb !== undefined ? { memoryLimitMb: options.memoryLimitMb } : {}),
		...(options.maxProcesses !== undefined ? { maxProcesses: options.maxProcesses } : {}),
		...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
		...(resolveEgressAllowlist(options) !== undefined
			? { egressAllowlist: resolveEgressAllowlist(options) }
			: {}),
	}

	let created: OrchestratorCreateResponse | undefined
	try {
		created = await orchestratorCall<OrchestratorCreateResponse>(
			endpoint,
			'/sandboxes',
			'POST',
			config.getToken,
			createBody,
		)
	} catch (err) {
		throw new Error(
			`firecracker: failed to create microVM sandbox — ${
				err instanceof Error ? err.message : String(err)
			}`,
			{ cause: err },
		)
	}
	if (!created || !created.sandboxId || !created.agent) {
		throw new Error('firecracker: orchestrator create returned no sandboxId / agent handle')
	}

	const id = created.sandboxId as SandboxId
	const rootDir = created.rootDir
	// If the handle is a vsock handle missing an explicit port, fill in
	// the contract port the agent is baked to listen on.
	const handle = normalizeHandle(created.agent, config.agentVsockPort ?? DEFAULT_AGENT_VSOCK_PORT)
	const transport = new VsockAgentTransport(handle, config.transport ?? {})

	const destroy = async (): Promise<void> => {
		await orchestratorCall(
			endpoint,
			`/sandboxes/${encodeURIComponent(id)}:delete`,
			'DELETE',
			config.getToken,
		)
	}

	try {
		// Readiness fence: the orchestrator's resume returns BEFORE the
		// guest agent has reseeded entropy and re-listened on vsock. Stop
		// the clock on the agent's healthz, exactly as the HTTP backends
		// wait on `/healthz` — never on the orchestrator's 2xx, which
		// fires before the guest runs (§5 clock semantics).
		await transport.waitForReady(
			config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
			config.readyPollIntervalMs ?? DEFAULT_READY_POLL_MS,
		)
	} catch (err) {
		// Best-effort orchestrator teardown so a readiness failure does not
		// orphan a microVM/netns/UFFD handler (the reaper backstops, but
		// surfacing the delete failure keeps the leak observable).
		try {
			await destroy()
		} catch {
			// Preserve the readiness error as primary.
		}
		throw err
	}

	let status: SandboxStatus = 'ready'

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
				return await transport.execute({
					command,
					args: argv ?? [],
					...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
					...(opts?.env !== undefined ? { env: opts.env } : {}),
					...(opts?.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
				})
			} finally {
				status = 'ready'
			}
		},

		async writeFile(path: string, content: string | Buffer): Promise<void> {
			const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
			await transport.writeFile(path, buf)
		},

		async readFile(path: string): Promise<Buffer> {
			return await transport.readFile(path)
		},

		async listFiles(rootPath: string): Promise<readonly SandboxFileEntry[]> {
			// Same wire as docker/aci: `find -printf '%p\t%s\n'`, parse
			// line-by-line, map a non-zero exit (missing root) to "empty".
			const result = await transport.execute({
				command: 'find',
				args: [rootPath, '-type', 'f', '-printf', '%p\t%s\n'],
			})
			if (result.exitCode !== 0) return []
			const entries: SandboxFileEntry[] = []
			for (const rawLine of result.stdout.split('\n')) {
				if (!rawLine) continue
				const tab = rawLine.indexOf('\t')
				if (tab < 0) continue
				const filePath = rawLine.slice(0, tab)
				const size = Number.parseInt(rawLine.slice(tab + 1), 10)
				if (!filePath || !Number.isFinite(size)) continue
				entries.push({ path: filePath, size })
			}
			return entries
		},

		async destroy(): Promise<void> {
			status = 'destroyed'
			// Let the orchestrator DELETE failure propagate — the
			// Vandal-side lifecycle wraps this with logging, and a
			// swallowed error here means orphaned microVMs (and their
			// netns / UFFD handlers) pile up with no observability handle.
			await destroy()
		},
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveEgressAllowlist(options: SandboxBackendOptions): readonly string[] | undefined {
	const egress = options.egress
	if (!egress) return undefined
	if (egress.kind === 'static') return egress.allowedHosts
	// `deny-all` → empty allowlist (explicit). `allow-all` / `resolver`
	// are resolved by the host before create when they apply; the
	// backend forwards only the static, already-resolved shape. A
	// resolver-shaped policy is the Vandal lifecycle's job to resolve
	// upstream and pass as `static`.
	if (egress.kind === 'deny-all') return []
	return undefined
}

function normalizeHandle(handle: SandboxAgentHandle, contractPort: number): SandboxAgentHandle {
	if (handle.kind === 'vsock' && (!handle.port || handle.port <= 0)) {
		return { kind: 'vsock', udsPath: handle.udsPath, port: contractPort }
	}
	return handle
}

function detectEnvironment(): SandboxEnvironment {
	// Firecracker guests run Linux; the agent is a Linux-namespace-style
	// worker from the SDK's perspective (the enum is host-shape, not
	// guest internals).
	return 'linux-namespace'
}
