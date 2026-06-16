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

import https from 'node:https'

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
import type {
	MtlsClientMaterial,
	SandboxAgentHandle,
	VsockTransportOptions,
	WireSandboxAgentHandle,
} from './transport.js'
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
	/**
	 * NETWORK-mode mTLS client material (ses_051 P4). When present AND the
	 * orchestrator returns an `mtls` agent handle, this CA/cert/key is MERGED
	 * onto the handle's `tls` block before the transport dials the per-host
	 * relay. The consumer's runtime injects it (mirrors `getToken`); this
	 * package never reads it from disk or fetches it, so it stays Azure-SDK
	 * free. Absent for the single-host VSOCK default (the live proofs).
	 */
	readonly mtls?: MtlsClientMaterial
	/**
	 * CONTROL-plane mTLS client material. When present, the orchestrator
	 * control-plane calls (`POST /sandboxes`, `DELETE /sandboxes/{id}:delete`,
	 * `GET /capacity`) dial over mTLS — presenting this client cert and
	 * verifying the orchestrator's server cert against this CA — INSTEAD of the
	 * plain `fetch`. This secures the control plane when `orchestratorEndpoint`
	 * is reached over the PUBLIC internet (the `ca-vandal-app` → FC-host hop is
	 * not VNet-integrated), where the shared-secret bearer alone would be
	 * exposed. The bearer is STILL sent (defense in depth on top of mTLS).
	 *
	 * Reuses the SAME `{ca,cert,key,servername}` shape as the relay's `mtls`
	 * material — one fleet CA secures both planes. The consumer's runtime
	 * injects the bytes (mirrors `getToken` / `mtls`); the package never reads
	 * them from disk. Absent → the control plane stays plain `fetch` (the
	 * single-host DEFAULT, byte-for-byte unchanged).
	 */
	readonly controlPlaneMtls?: MtlsClientMaterial
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
	readonly agent: WireSandboxAgentHandle
	readonly rootDir: string
}

/** A transport-agnostic view of the orchestrator response the dispatch needs. */
interface OrchestratorRawResponse {
	readonly status: number
	readonly contentType: string
	readonly text: () => Promise<string>
}

async function orchestratorCall<T>(
	endpoint: string,
	pathSuffix: string,
	method: 'POST' | 'DELETE',
	getToken: OrchestratorTokenProvider,
	body?: unknown,
	mtls?: MtlsClientMaterial,
): Promise<T | undefined> {
	const token = await getToken()
	const url = `${endpoint.replace(/\/+$/, '')}${pathSuffix}`
	const payload = body !== undefined ? JSON.stringify(body) : undefined
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		'content-type': 'application/json',
	}

	let res: OrchestratorRawResponse
	try {
		// When CONTROL-plane mTLS material is injected the call dials over a
		// node:https request presenting the client cert + pinning the server CA
		// (the public-internet hop). Without it the EXISTING plain `fetch` path
		// runs unchanged (the single-host default). node:https is used rather
		// than fetch+undici-dispatcher because the package declares no undici
		// dependency — node:https is always importable and needs nothing added.
		res = mtls
			? await httpsOrchestratorRequest(url, method, headers, payload, mtls)
			: await fetchOrchestratorRequest(url, method, headers, payload)
	} catch (err) {
		const cause = err instanceof Error ? err.cause : undefined
		throw new Error(
			`firecracker orchestrator ${method} ${url} failed: ${
				err instanceof Error ? err.message : String(err)
			}${cause ? ` — cause: ${cause instanceof Error ? cause.message : String(cause)}` : ''}`,
			{ cause: err },
		)
	}
	if (res.status < 200 || res.status >= 300) {
		throw new Error(
			`firecracker orchestrator ${method} ${url} → ${res.status}: ${await res.text()}`,
		)
	}
	if (res.status === 204) return undefined
	if (res.contentType.includes('application/json')) return JSON.parse(await res.text()) as T
	return undefined
}

/** The plain-`fetch` control-plane path — the single-host DEFAULT, unchanged. */
async function fetchOrchestratorRequest(
	url: string,
	method: 'POST' | 'DELETE',
	headers: Record<string, string>,
	payload: string | undefined,
): Promise<OrchestratorRawResponse> {
	const init: RequestInit = { method, headers }
	if (payload !== undefined) init.body = payload
	const res = await fetch(url, init)
	return {
		status: res.status,
		contentType: res.headers.get('content-type') ?? '',
		text: () => res.text(),
	}
}

/**
 * The mTLS control-plane path: a node:https request presenting the injected
 * client cert and verifying the orchestrator's server cert against the injected
 * CA (`rejectUnauthorized: true`). Used only when `controlPlaneMtls` is present;
 * the plain-`fetch` path above stays the default for single-host.
 */
function httpsOrchestratorRequest(
	url: string,
	method: 'POST' | 'DELETE',
	headers: Record<string, string>,
	payload: string | undefined,
	mtls: MtlsClientMaterial,
): Promise<OrchestratorRawResponse> {
	const target = new URL(url)
	return new Promise<OrchestratorRawResponse>((resolve, reject) => {
		const req = https.request(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port !== '' ? Number(target.port) : 443,
				path: `${target.pathname}${target.search}`,
				method,
				headers,
				ca: mtls.ca,
				cert: mtls.cert,
				key: mtls.key,
				rejectUnauthorized: true,
				minVersion: 'TLSv1.3',
				...(mtls.servername !== undefined ? { servername: mtls.servername } : {}),
			},
			(res) => {
				const chunks: Buffer[] = []
				res.on('data', (chunk: Buffer) => chunks.push(chunk))
				res.on('end', () => {
					const ct = res.headers['content-type']
					resolve({
						status: res.statusCode ?? 0,
						contentType: Array.isArray(ct) ? (ct[0] ?? '') : (ct ?? ''),
						text: async () => Buffer.concat(chunks).toString('utf8'),
					})
				})
				res.on('error', reject)
			},
		)
		req.on('error', reject)
		if (payload !== undefined) req.write(payload)
		req.end()
	})
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
			config.controlPlaneMtls,
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
	// Normalise the orchestrator handle: fill the contract vsock port when a
	// vsock handle omits it, and MERGE the consumer-injected mTLS material onto
	// a network (`mtls`) handle so the transport can dial the relay. The
	// orchestrator returns an `mtls` handle WITHOUT cert material (host/port/
	// sandboxId only); the certs are injected here from `config.mtls`, never
	// shipped by the control plane.
	const handle = normalizeHandle(
		created.agent,
		config.agentVsockPort ?? DEFAULT_AGENT_VSOCK_PORT,
		config.mtls,
	)
	const transport = new VsockAgentTransport(handle, config.transport ?? {})

	const destroy = async (): Promise<void> => {
		await orchestratorCall(
			endpoint,
			`/sandboxes/${encodeURIComponent(id)}:delete`,
			'DELETE',
			config.getToken,
			undefined,
			config.controlPlaneMtls,
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

/**
 * Turn the orchestrator's WIRE handle into the transport handle the dialer
 * uses. Two transforms:
 *
 *  - `vsock` with a missing/<=0 port → fill the contract port.
 *  - `mtls` → MERGE the consumer-injected `mtls` cert material onto the
 *    wire handle (which carries only host/port/sandboxId). The orchestrator
 *    never ships cert material; without an injected `mtls` block a network
 *    handle cannot dial, so this throws loud rather than constructing a
 *    transport that would fail at connect time.
 *
 * `unix` + already-correct `vsock` handles pass through untouched.
 */
export function normalizeHandle(
	handle: WireSandboxAgentHandle,
	contractPort: number,
	mtls: MtlsClientMaterial | undefined,
): SandboxAgentHandle {
	if (handle.kind === 'mtls') {
		if (!mtls) {
			throw new Error(
				'firecracker: orchestrator returned an mtls agent handle but no client cert material was injected ' +
					'(the Vandal host layer must supply VANDAL_SANDBOX_FC_TLS_CA/_CERT/_KEY in network mode)',
			)
		}
		return {
			kind: 'mtls',
			host: handle.host,
			port: handle.port,
			sandboxId: handle.sandboxId,
			tls: {
				ca: mtls.ca,
				cert: mtls.cert,
				key: mtls.key,
				...(mtls.servername !== undefined ? { servername: mtls.servername } : {}),
			},
		}
	}
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
