/**
 * `container:docker` backend.
 *
 * Spawns one Docker container per `Sandbox` instance via the
 * `docker` CLI (no node-docker SDK dependency — keeps the package
 * thin). The container runs the small HTTP worker shipped under
 * `packages/sandbox/worker/server.js`; the host adapter talks to
 * it on `127.0.0.1:<random-port>`.
 *
 * One container per sandbox, not one per `exec` call: keeps cold-
 * start out of the hot path. The container goes away in
 * `destroy()`.
 *
 * Trust model:
 *  - Container is the trust boundary; everything inside is treated
 *    as untrusted code.
 *  - Worker only listens on loopback inside its own netns; the
 *    host adapter reaches it via Docker's port-forward.
 *  - Outbound network from the worker is restricted by host-side
 *    firewall config (see {@link DockerBackendConfig.network}) plus
 *    the egress proxy when one is configured (P3.2).
 */

import { spawn } from 'node:child_process'

import {
	type ContainerSandboxLayout,
	type ContainerSandboxLayoutMount,
	type ResolvedContainerSandboxLayout,
	SANDBOX_DEFAULT_OUTPUTS_PATH,
	SANDBOX_DEFAULT_SCRATCH_PATH,
	SANDBOX_DEFAULT_SKILLS_PARENT,
	SANDBOX_DEFAULT_TOOL_RESULTS_PATH,
	SANDBOX_DEFAULT_TRANSCRIPTS_PATH,
	SANDBOX_DEFAULT_UPLOADS_PATH,
	type Sandbox,
	type SandboxDestroyOptions,
	type SandboxEnvironment,
	type SandboxExecOptions,
	type SandboxExecResult,
	type SandboxFileEntry,
	type SandboxId,
	type SandboxStatus,
	asSandboxId,
	withHint,
} from '@namzu/sdk'
import { EgressProxy } from '../../egress/index.js'
import type {
	BrokeredCredential,
	EgressProxyOptions,
	RunningEgressProxy,
} from '../../egress/index.js'

import {
	ContainerSandboxLayoutValidationError,
	type EgressPolicy,
	type SandboxBackend,
	type SandboxBackendOptions,
} from '../../index.js'
import {
	OperationDeadline,
	OperationDeadlineExpired,
	probeHttpHealth,
	resolveReadinessOptions,
	runFailureCleanup,
} from '../readiness.js'

/**
 * Backend-specific tuning. Most hosts use the defaults; advanced
 * deployments override `image` to point at their own pre-built
 * image, or pin `dockerBinary` for non-standard installs.
 *
 * The container's mount layout is baked in at provider construction
 * via {@link DockerBackendInternalConfig.layout} — every `create()`
 * call inherits the same layout. This is by design: per-task hosts
 * call `createSandboxProvider` once per task, with that task's
 * layout. There is no per-call layout argument, so the SDK runtime
 * cannot accidentally call a docker provider without one.
 */
export interface DockerBackendInternalConfig {
	readonly image: string
	/**
	 * Pre-resolved layout. Construction-time `resolveLayout` validates
	 * and applies defaults; the docker backend renders mount flags
	 * directly from this without re-validating.
	 */
	readonly layout: ResolvedContainerSandboxLayout
	readonly dockerBinary?: string

	/**
	 * `--user` value for the container, e.g. `'1000:1000'` or `'nobody'`.
	 *
	 * Left unset by default because the correct uid depends on the image's
	 * own filesystem ownership, and forcing one would break every image
	 * that expects root at startup. Set it whenever the image supports a
	 * non-root user — a container running as root is one bind-mount
	 * misconfiguration away from writing the host.
	 */
	readonly runAsUser?: string

	/**
	 * Credentials the egress proxy stamps on, per host.
	 *
	 * The point is that the real value never enters the sandbox. Any token
	 * the agent needs to reach an allowed host used to have to be in the
	 * container's environment — readable by the untrusted code it is meant
	 * to be isolated from, via `/proc/self/environ` or via a prompt
	 * injection that exfiltrates it over the very egress the policy
	 * permits. Here it is held host-side and applied at the boundary.
	 */
	readonly brokeredCredentials?: readonly BrokeredCredential[]

	/**
	 * Allowlisted hosts permitted to resolve to an inward address anyway.
	 *
	 * The egress boundary refuses a host that resolves to loopback, a private
	 * range or the link-local metadata block, whatever the allowlist says —
	 * because an allowlisted name whose DNS someone else controls is not a
	 * permitted destination, it is a permitted spelling. An operator who
	 * genuinely proxies to one service on a private network names it here.
	 *
	 * Per host, matched by the allowlist's own rules so `.internal.example`
	 * covers subdomains. There is deliberately no switch that turns the screen
	 * off: one would hand every other allowlisted name the same reach, which
	 * is the hole the screen exists to close.
	 */
	readonly allowInwardFor?: readonly string[]

	readonly network?: 'none' | 'bridge' | string
	readonly readyPollIntervalMs?: number
	readonly readyTimeoutMs?: number
	/**
	 * Docker runtime to launch the container under. Default `runc`
	 * (vanilla Docker namespaces, what Docker Desktop ships). Linux
	 * production deployments that have registered gVisor on the host
	 * daemon can pass `runsc` to upgrade to a userspace-kernel trust
	 * boundary — the usual primitive for running untrusted code at
	 * scale. Hosts can also pass a custom runtime name registered in
	 * `daemon.json`. macOS Docker Desktop has no `runsc` runtime, so
	 * the default `runc` is the only option there; that's documented
	 * as the local-dev tier in the package README.
	 */
	readonly runtime?: 'runc' | 'runsc' | string
	/**
	 * How the SDK consumer reaches the in-container worker:
	 *
	 *  - `'host-port'` (default): publish the worker port on the
	 *    host loopback (`127.0.0.1::<random>`) and connect by host
	 *    port. Works when the SDK runs ON the docker host (CLI,
	 *    direct dev). Backward-compatible — the original behaviour.
	 *
	 *  - `'container-network'`: skip `--publish` entirely, attach
	 *    the spawned container to a shared docker bridge that the
	 *    SDK consumer is also on, and connect by container DNS name
	 *    (`http://<containerName>:2024`). Required when the SDK
	 *    runs INSIDE a container (e.g. Vandal's app container
	 *    spawning sibling sandbox containers via the host's Docker
	 *    daemon — `127.0.0.1` inside the app is the app, not the
	 *    sandbox). The shared bridge name comes from `config.network`.
	 */
	readonly hostReachability?: 'host-port' | 'container-network'
	/**
	 * Optional `--label key=value` pairs applied to the spawned
	 * container at `docker run` time. Used by hosts that need to
	 * find their containers from out-of-band code paths (reaper jobs,
	 * monitoring filters) via `docker ps --filter label=…`. Keys
	 * containing `=` or empty names throw at spawn time — the docker
	 * CLI accepts them but the resulting label split is ambiguous.
	 */
	readonly labels?: Readonly<Record<string, string>>
}

const DEFAULT_DOCKER_BINARY = 'docker'
const DEFAULT_READY_POLL_MS = 100
const DEFAULT_READY_TIMEOUT_MS = 30_000
const WORKER_PORT_INSIDE_CONTAINER = 2024

/**
 * Build a {@link SandboxBackend} backed by Docker. Construction is
 * synchronous; the actual container spawns on the first
 * `create()` call.
 */
export function buildDockerBackend(config: DockerBackendInternalConfig): SandboxBackend {
	const readiness = resolveReadinessOptions(
		'docker',
		config.readyTimeoutMs,
		config.readyPollIntervalMs,
		{
			timeoutMs: DEFAULT_READY_TIMEOUT_MS,
			pollIntervalMs: DEFAULT_READY_POLL_MS,
		},
	)
	return {
		tier: 'container',
		name: 'docker',
		async create(options: SandboxBackendOptions) {
			return await spawnDockerSandbox(config, options, readiness)
		},
	}
}

/**
 * Reconcile the configured docker network with the caller's egress policy.
 *
 * The policy used to be accepted and silently ignored, which is worse than
 * not supporting it: a host that set `deny-all` believed the container had
 * no network and it had the configured one. It cannot enforce a host
 * allowlist without a proxy this backend does not have, so those policies
 * are REFUSED rather than quietly downgraded to "allow everything".
 *
 * `deny-all` used to answer `'none'`, which reads as the strictest possible
 * answer and produced a sandbox nobody could reach. `--network none`
 * removes every interface, and this backend's control channel is inbound
 * TCP to the worker — so removing the interfaces removes the way IN, not
 * just the way out. It now keeps the configured network, and
 * {@link assertNetworkCarriesThePolicy} is what makes that network a
 * boundary.
 */
export function resolveNetwork(
	configured: string,
	egress: EgressPolicy | undefined,
	hasProxy = false,
): string {
	if (!egress) return configured

	switch (egress.kind) {
		case 'deny-all':
		case 'allow-all':
			return configured
		default:
			// A host allowlist needs something to filter through. With the
			// egress proxy the container keeps its network and every request
			// crosses that boundary; without one there is nothing to enforce
			// with, and accepting the policy would grant everything while
			// reporting that it had been restricted.
			if (hasProxy) return configured
			throw new Error(
				`The docker sandbox backend cannot enforce an egress policy of kind '${egress.kind}' without an egress proxy: it has nothing to filter hosts through. Construct the provider with one, or use 'deny-all' / 'allow-all'. Refusing rather than silently granting full network access.`,
			)
	}
}

/**
 * Hosts an allowlist policy permits.
 *
 * Only the two filtering kinds reach here. `deny-all` is enforced by the
 * container runtime itself and `allow-all` needs no boundary, so routing
 * either through an allowlist would answer a question nobody asked — and
 * for `allow-all` it would answer "nothing", denying everything.
 */
export async function resolveAllowedHosts(egress: EgressPolicy): Promise<readonly string[]> {
	if (egress.kind === 'static') return egress.allowedHosts
	if (egress.kind === 'resolver') return await egress.resolve()
	throw new Error(
		`Egress policy of kind "${egress.kind}" does not describe a host allowlist and must not be routed through the proxy.`,
	)
}

/** Whether a policy needs a boundary before it can be enforced at all. */
export function needsEgressProxy(egress: EgressPolicy | undefined): boolean {
	return egress?.kind === 'static' || egress?.kind === 'resolver'
}

/**
 * Whether the daemon says a network has no route out.
 *
 * Takes the raw `docker network inspect --format '{{.Internal}}'` output
 * rather than reading it, so every decision below is testable without a
 * daemon and the daemon call stays one line. Anything other than a literal
 * `true` counts as "not internal": an unreadable answer is not evidence of
 * a boundary.
 */
export function isInternalNetwork(inspectedInternalFlag: string): boolean {
	return inspectedInternalFlag.trim() === 'true'
}

/**
 * Refuse a container whose network cannot do what was asked of it.
 *
 * Two requirements meet on the same object here, and both were previously
 * unstated — which is how the backend came to ship a default configuration
 * that could not create a sandbox at all:
 *
 *  - **A published host port needs a route out.** Docker binds the port by
 *    NAT to the container's address, so a container with no address gets no
 *    binding. Measured against Docker 29.6: `--network none --publish
 *    127.0.0.1::2024` is *accepted*, `NetworkSettings.Ports` comes back
 *    `{"2024/tcp":[]}`, and `docker port` prints nothing. An `--internal`
 *    network behaves the same way. The port readback then failed with
 *    `index of untyped nil` and reported it as "the container exited
 *    immediately" — blaming a container that was alive and well.
 *  - **`deny-all` needs a network with no route out.** Since it no longer
 *    answers `--network none`, the configured name is all that stands
 *    between the policy and ordinary outbound networking, and a name says
 *    nothing. `deny-all` pointed at the default bridge would be full egress
 *    under a policy object claiming none — the "accepted and silently
 *    ignored" failure the rest of this file exists to refuse.
 *
 * They are exact opposites, so `deny-all` over a published host port is
 * impossible rather than merely unsupported: no arrangement of docker
 * networking both denies all egress and lets the host reach the worker over
 * TCP. Closing that needs the control channel moved off TCP — see #398 —
 * and is not a flag this function could accept.
 */
export function assertNetworkCarriesThePolicy(
	network: string,
	reachability: 'host-port' | 'container-network',
	egress: EgressPolicy | undefined,
	inspectedInternalFlag: string,
): void {
	const internal = isInternalNetwork(inspectedInternalFlag)

	if (reachability === 'host-port' && (network === 'none' || internal)) {
		throw new Error(
			`The docker sandbox backend cannot publish the worker's port on network '${network}': docker binds a published port to the container's address, and a container with no route out has no address to bind to, so nothing is published and the sandbox is unreachable. Either give config.network a bridge that has one, or set hostReachability: 'container-network' and reach the worker by container name. Refusing rather than starting a container nobody can reach.`,
		)
	}

	if (egress?.kind === 'deny-all' && !internal) {
		throw new Error(
			`The docker sandbox backend was asked for an egress policy of 'deny-all' on network '${network}', but that network is not internal, so the container can still reach the world. Create it with 'docker network create --internal ${network}' — an internal bridge denies egress in the kernel, rather than through an environment variable a workload may decline to read, while sibling containers still reach the worker by name. Refusing rather than reporting a boundary that is not there.`,
		)
	}
}

/**
 * The options the boundary is built from, as a value.
 *
 * Extracted for the same reason {@link resolveNetwork} is: everything
 * downstream of here needs a running Docker daemon, so a policy that never
 * reached the proxy could only be caught by an operator noticing their
 * traffic denied in production. A knob a host sets and the boundary never
 * receives is the failure this shape exists to make testable.
 */
export function egressProxyOptions(
	config: Pick<DockerBackendInternalConfig, 'brokeredCredentials' | 'allowInwardFor'>,
	policy: EgressPolicy,
): EgressProxyOptions {
	return {
		// Re-resolved per request rather than captured once, so a `resolver`
		// policy that rotates is honoured and `setNetworkPolicy` can swap it
		// on a live sandbox.
		allowedHosts: () => resolveAllowedHosts(policy),
		credentials: config.brokeredCredentials ?? [],
		...(config.allowInwardFor ? { allowInwardFor: config.allowInwardFor } : {}),
	}
}

/**
 * Confinement flags applied to every container.
 *
 * A sandbox whose containers run as root with the full default capability
 * set is not confining much: `CAP_DAC_OVERRIDE` alone walks past the
 * read-only bind mounts the layout sets up, and without
 * `no-new-privileges` a setuid binary inside the image re-escalates. These
 * are the defaults every container runtime hardening guide starts with,
 * and none of them were present.
 *
 * `--cap-drop=ALL` is deliberately not softened by a re-add list: a
 * workload that genuinely needs a capability should say so through
 * `extraRunArgs` and be visible in review.
 *
 * **It carries a second, independent load, and this is the one that would
 * survive being forgotten.** An egress policy of `deny-all` is enforced by
 * the container's network being `--internal`, which gives it no route out.
 * Measured against Docker 29.6: a container on such a network has only its
 * own subnet in `ip route` and no default, and `ip route add default via
 * <a sibling>` answers `RTNETLINK answers: Operation not permitted` —
 * already, with docker's DEFAULT capability set, before this flag is
 * applied. `NET_ADMIN` is what would lift that, and dropping every
 * capability is what guarantees the workload does not have it.
 *
 * So the internal network removes the route and this flag removes the
 * ability to put one back. Both are needed. Measured on a container given
 * `--cap-add=NET_ADMIN`, adding the route and reaching a sibling attached
 * to an external bridge produces `download timed out` rather than
 * `Network unreachable` — the route existed, the packet left, and the
 * dual-homed sibling forwarded it (`net.ipv4.ip_forward` is `1` inside a
 * container). Nothing masquerades the internal subnet so no reply finds its
 * way back and no connection establishes, **but that is not a security
 * property**: one-way egress is sufficient for exfiltration, and what was
 * measured is that the handshake fails, not that the packet was dropped.
 *
 * Recorded here because the first justification above would survive
 * softening this flag and the second would not.
 */
const HARDENING_ARGS: readonly string[] = ['--cap-drop=ALL', '--security-opt=no-new-privileges']

/** Name the container reaches the host-side egress proxy by. */
const PROXY_HOST_ALIAS = 'namzu-egress'

async function spawnDockerSandbox(
	config: DockerBackendInternalConfig,
	options: SandboxBackendOptions,
	readiness: { readonly timeoutMs: number; readonly pollIntervalMs: number },
): Promise<Sandbox> {
	options.signal?.throwIfAborted()
	const resolvedLayout = config.layout
	const id = generateSandboxId()
	const docker = config.dockerBinary ?? DEFAULT_DOCKER_BINARY

	// The boundary a host allowlist is actually enforced at. Started before
	// the container so its address can be handed in as proxy environment,
	// and torn down with the sandbox — a proxy holding real credentials
	// must not outlive the thing it was filtering for.
	let egressProxy: RunningEgressProxy | undefined
	if (needsEgressProxy(options.egress) && options.egress) {
		const policy = options.egress
		try {
			egressProxy = await new EgressProxy(egressProxyOptions(config, policy)).listen()
			options.signal?.throwIfAborted()
		} catch (error) {
			await egressProxy?.close().catch(() => undefined)
			throw error
		}
	}

	const hostReachability = config.hostReachability ?? 'host-port'
	const network = resolveNetwork(
		config.network ?? 'none',
		options.egress,
		egressProxy !== undefined,
	)
	// Whether this network can carry the reachability mode and the policy is
	// a fact about the network, so it is checked against the daemon rather
	// than inferred from its name. Before the container starts on purpose: a
	// refusal here is a wiring mistake and must not arrive dressed as a
	// container that failed to come up, which is exactly how it used to
	// arrive.
	try {
		assertNetworkCarriesThePolicy(
			network,
			hostReachability,
			options.egress,
			await inspectNetworkInternalFlag(docker, network, options.signal),
		)
	} catch (err) {
		// The allowlist kinds start a proxy above, and this is outside the
		// try/catch that owns teardown — so without this the refusal would
		// leave a listening server on loopback stamping real credentials.
		await egressProxy?.close().catch(() => undefined)
		throw err
	}
	const runtime = config.runtime
	const containerName = `namzu-sandbox-${id}`

	// All bind sources come from the consumer-supplied layout. The
	// backend never allocates host directories and never removes them
	// — that pre-existing single-mount mkdtemp path was the source of
	// the EACCES bug in sibling-container setups (the consumer owns
	// the host filesystem, the spawned backend can't reach it from
	// inside its own container's mount namespace). Clean break.
	async function cleanupOnFailure(signal: AbortSignal) {
		// The name is known before `docker run`. Remove by name even when the
		// client process was interrupted before it reported success: the daemon
		// may already have committed the container. This is best-effort
		// reconciliation; an external daemon that commits after this delete still
		// needs its ordinary label/name reaper.
		const removeContainer = runOnceQuiet(docker, ['rm', '-f', containerName], signal)
		// The proxy starts BEFORE the container and its only other close is
		// in `destroy()`, which a create that never returned can never
		// reach. So every failure between the two — a daemon that is down, a
		// port that could not be read, a worker that missed its readiness
		// deadline, a label the validator rejected — left a listening server
		// on loopback stamping real credential headers, plus a retained
		// event-loop handle, and a retry loop left one per attempt. That is
		// exactly the invariant this file states where the proxy is started:
		// it must not outlive the thing it was filtering for.
		// Start both teardown arms before awaiting either. A stuck runtime must
		// not prevent the proxy from releasing its credential-bearing listener.
		const closeProxy = egressProxy?.close().catch(() => undefined) ?? Promise.resolve()
		egressProxy = undefined
		await Promise.all([removeContainer, closeProxy])
	}

	let hostPort: number
	let baseUrl: string
	// `outputs` is required by validation, so its containerPath is
	// always available — the worker uses it as its workspace root.
	const rootDir = resolvedLayout.outputs.containerPath

	try {
		// Let Docker pick the host port instead of pre-reserving one
		// in this process. The reservePort()-then-publish-fixed-port
		// pattern had a TOCTOU window: the OS could hand the port to
		// another process between our `server.close()` and Docker's
		// `bind()`. Letting Docker pick (`--publish-all`) and reading
		// the mapping back via `docker inspect` removes the race.
		const args: string[] = [
			'run',
			'--detach',
			'--rm',
			'--name',
			containerName,
			'--network',
			network,
			...HARDENING_ARGS,
			...(config.runAsUser ? ['--user', config.runAsUser] : []),
		]

		// `--label key=value` flags. Validate first — an empty key or
		// a key containing `=` would silently produce a malformed
		// label that downstream `docker ps --filter label=…` queries
		// could not match reliably. Throw before the spawn so misuse
		// surfaces during construction, not as a mysterious "container
		// has no labels" later.
		if (config.labels) {
			for (const [key, value] of Object.entries(config.labels)) {
				if (!key || key.includes('=')) {
					throw new Error(
						`docker label key ${JSON.stringify(key)} is invalid (empty or contains '=')`,
					)
				}
				args.push('--label', `${key}=${value}`)
			}
		}

		args.push(...renderLayoutMountArgs(resolvedLayout))
		// Forward only the workspace root so the worker's lexical
		// resolver agrees with the bind target. The full layout used
		// to ride along as `NAMZU_SANDBOX_LAYOUT`, but the worker
		// never branched on it; the manifest's only consumer was a
		// log line. A skill loader that needs the manifest will
		// write it to a bind path the worker reads at startup —
		// avoids env-size limits, keeps the wire shape minimal.
		if (egressProxy) {
			// `host-gateway` is docker's own portable name for the host from
			// inside a container; hard-coding a bridge address would break on
			// every platform whose bridge is numbered differently. The proxy
			// itself binds loopback, so this alias is the only way in.
			args.push('--add-host', `${PROXY_HOST_ALIAS}:host-gateway`)
			const proxyUrl = `http://${PROXY_HOST_ALIAS}:${egressProxy.port}`
			// Both spellings: tooling is split between them, and a workload
			// that reads only the one that is missing bypasses the boundary
			// entirely — which would look exactly like the policy working.
			for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
				args.push('--env', `${key}=${proxyUrl}`)
			}
			// Loopback must not be proxied, or the worker cannot talk to
			// itself.
			args.push('--env', 'NO_PROXY=localhost,127.0.0.1')
			args.push('--env', 'no_proxy=localhost,127.0.0.1')
		}

		args.push('--env', `NAMZU_SANDBOX_WORKSPACE=${rootDir}`)
		args.push('--env', `NAMZU_SANDBOX_READ_ROOTS=${renderLayoutReadRootsEnv(resolvedLayout)}`)
		args.push('--env', `NAMZU_SANDBOX_WRITE_ROOTS=${renderLayoutWriteRootsEnv(resolvedLayout)}`)

		// Only publish a host port when the consumer is going to reach
		// the worker through the docker host's loopback (CLI / direct
		// dev). For `container-network` reachability we leave the port
		// unpublished — sibling containers reach the worker by its DNS
		// name on the shared bridge, no host port required.
		if (hostReachability === 'host-port') {
			args.push('--publish', `127.0.0.1::${WORKER_PORT_INSIDE_CONTAINER}`)
		}

		if (runtime) {
			args.push('--runtime', runtime)
		}

		if (options.memoryLimitMb && options.memoryLimitMb > 0) {
			args.push('--memory', `${options.memoryLimitMb}m`)
		}
		if (options.maxProcesses && options.maxProcesses > 0) {
			args.push('--pids-limit', String(options.maxProcesses))
		}

		for (const [key, value] of Object.entries(options.env ?? {})) {
			args.push('--env', `${key}=${value}`)
		}

		args.push(config.image)

		await runOnce(docker, args, options.signal)
		if (hostReachability === 'host-port') {
			hostPort = await readMappedPort(docker, containerName, options.signal)
			baseUrl = `http://127.0.0.1:${hostPort}`
			await waitForWorkerReady(
				baseUrl,
				readiness.timeoutMs,
				readiness.pollIntervalMs,
				options.signal,
			)
		} else {
			// container-network: connect by container DNS name on the
			// shared bridge. No host port to read; the SDK consumer is
			// itself a container on the same bridge.
			baseUrl = `http://${containerName}:${WORKER_PORT_INSIDE_CONTAINER}`
			await waitForWorkerReady(
				baseUrl,
				readiness.timeoutMs,
				readiness.pollIntervalMs,
				options.signal,
			)
		}
	} catch (err) {
		await runFailureCleanup(cleanupOnFailure)
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
				return await execViaWorker(baseUrl, command, argv, opts)
			} finally {
				status = 'ready'
			}
		},

		async setNetworkPolicy(policy): Promise<void> {
			// Enforceable only through the egress proxy. Without one the
			// container's network was fixed at creation — `--network none`
			// or not — and there is nothing to narrow: accepting the policy
			// here and doing nothing would leave the caller believing the
			// sandbox had been confined when it had not. Same rule the
			// egress-kind refusal above follows.
			if (!egressProxy) {
				throw withHint(
					new Error(
						'This sandbox cannot change its network policy: it was created without an egress proxy, so its network was fixed at creation and there is nothing to narrow. Refusing rather than accepting a policy that would not be applied.',
					),
					'Construct the provider with an egress proxy to make the policy mutable, or create a second sandbox under the narrower policy.',
				)
			}
			egressProxy.setAllowedHosts(async () => policy.allowedHosts)
		},

		async writeFile(path: string, content: string | Buffer): Promise<void> {
			const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
			let res: Response
			try {
				res = await fetch(`${baseUrl}/write-file`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						path,
						content: buf.toString('base64'),
						encoding: 'base64',
					}),
				})
			} catch (err) {
				const cause = err instanceof Error ? err.cause : undefined
				const causeMsg =
					cause instanceof Error
						? `${cause.message}${(cause as Error & { code?: string }).code ? ` (${(cause as Error & { code?: string }).code})` : ''}`
						: cause
							? String(cause)
							: 'unknown'
				throw new Error(
					`namzu-sandbox /write-file fetch failed (baseUrl=${baseUrl}, path=${path}): ${err instanceof Error ? err.message : String(err)} — cause: ${causeMsg}`,
					{ cause: err },
				)
			}
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
			return await listFilesViaWorker(baseUrl, rootPath)
		},

		async destroy(options?: SandboxDestroyOptions): Promise<void> {
			status = 'destroyed'
			await runOnceQuiet(docker, ['rm', '-f', containerName], options?.signal)
			// The proxy holds real credentials and a live allowlist. Leaving
			// it listening after the sandbox it was filtering for is gone
			// means a loopback port that still stamps a token onto anything
			// that asks — outliving the only thing that justified it.
			await egressProxy?.close()
			// Backend never allocates host paths — every bind source
			// comes from the consumer-supplied layout. Container
			// teardown is sufficient; the consumer's own lifecycle
			// owns each `hostPath`.
		},
	}
}

/**
 * Ask Docker which host port it bound to the worker port. Used
 * instead of the pre-reserve-then-publish pattern (which had a
 * TOCTOU race window between this process closing the listening
 * socket and Docker's bind picking the same port — another
 * process could grab it in the meantime). Letting Docker
 * allocate and reading the mapping back is race-free.
 */
async function readMappedPort(
	docker: string,
	containerName: string,
	signal?: AbortSignal,
): Promise<number> {
	const inspectOutput = await runOnce(
		docker,
		[
			'inspect',
			'--format',
			`{{(index (index .NetworkSettings.Ports "${WORKER_PORT_INSIDE_CONTAINER}/tcp") 0).HostPort}}`,
			containerName,
		],
		signal,
	)
	const port = Number(inspectOutput.trim())
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw withHint(
			new Error(
				`docker inspect returned no usable host port mapping for ${containerName}: '${inspectOutput}'`,
			),
			'The container started but its worker port was never published. Usually the container exited immediately — check its logs — or the host had no free port to bind.',
		)
	}
	return port
}

async function execViaWorker(
	baseUrl: string,
	command: string,
	argv: string[] | undefined,
	opts: SandboxExecOptions | undefined,
): Promise<SandboxExecResult> {
	// `opts.signal` is deliberately NOT passed to `fetch`. It would abort the
	// request and leave the worker running the command — abandoning the wait
	// while the process lives on is the exact failure
	// `SandboxExecOptions.signal` exists to prevent, and wiring it here would
	// make the option look honoured while delivering that failure. Honouring
	// it needs a cancel endpoint on the worker.
	const start = Date.now()
	let res: Response
	try {
		res = await fetch(`${baseUrl}/execute`, {
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
	} catch (err) {
		// Surface the underlying transport error (DNS, ECONNREFUSED,
		// socket-hangup, …) instead of the generic "fetch failed" the
		// undici client throws. Without `cause`, ops cannot tell whether
		// the worker died, the bridge dropped, or something else.
		const cause = err instanceof Error ? err.cause : undefined
		const causeMsg =
			cause instanceof Error
				? `${cause.message}${(cause as Error & { code?: string }).code ? ` (${(cause as Error & { code?: string }).code})` : ''}`
				: cause
					? String(cause)
					: 'unknown'
		throw withHint(
			new Error(
				`namzu-sandbox /execute fetch failed (baseUrl=${baseUrl}): ${err instanceof Error ? err.message : String(err)} — cause: ${causeMsg}`,
				{ cause: err },
			),
			'The container was reachable when it started, so it has most likely exited or been killed since — an out-of-memory kill under `memoryLimitMb` is the common cause. Check the container logs and its exit code.',
		)
	}
	if (!res.ok || !res.body) {
		throw new Error(`execute failed: HTTP ${res.status} ${await res.text()}`)
	}

	let stdout = ''
	let stderr = ''
	let exitCode = -1
	let timedOut = false
	let signal: string | undefined

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
						| {
								type: 'result'
								exitCode: number
								timedOut: boolean
								durationMs: number
						  }
						| { type: 'error'; error: string }
					if (event.type === 'stdout_delta') {
						stdout += event.data
						opts?.onOutput?.({ stream: 'stdout', data: event.data })
					} else if (event.type === 'stderr_delta') {
						stderr += event.data
						opts?.onOutput?.({ stream: 'stderr', data: event.data })
					} else if (event.type === 'result') {
						exitCode = event.exitCode
						timedOut = event.timedOut
					} else if (event.type === 'error') {
						throw new Error(event.error)
					}
				} catch (err) {
					if (err instanceof SyntaxError) {
						// Ignore malformed lines from the worker.
					} else {
						throw err
					}
				}
			}
			newlineIdx = buffered.indexOf('\n')
		}
	}

	return {
		exitCode,
		stdout,
		stderr,
		...(signal ? { signal } : {}),
		timedOut,
		durationMs: Date.now() - start,
	}
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
	baseUrl: string,
	rootPath: string,
): Promise<readonly SandboxFileEntry[]> {
	const result = await execViaWorker(
		baseUrl,
		'find',
		[rootPath, '-type', 'f', '-printf', '%p\t%s\n'],
		undefined,
	)
	if (result.exitCode !== 0) {
		// `find` returns non-zero when the root is missing — that just
		// means "no outputs yet". Other failures (permission errors,
		// the rare case `find` itself is missing) also fall through to
		// the empty listing rather than blowing up the caller's drain
		// flow; the deliverables collector treats absence as "done".
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

function detectEnvironment(): SandboxEnvironment {
	const platform = process.platform
	if (platform === 'darwin') return 'macos-seatbelt'
	if (platform === 'linux') return 'linux-namespace'
	return 'basic'
}

function generateSandboxId(): SandboxId {
	// `sbx_`, not `sandbox_`. `SandboxId` is `` `sbx_${string}` `` and this
	// backend minted `sandbox_...` for it — the `as SandboxId` was the only
	// reason that compiled, and every docker sandbox in the tree carried an id
	// its own type says is impossible. The ACI backend already mints `sbx_`.
	//
	// The container name derives from this (`namzu-sandbox-${id}`), so a
	// container started by an older build has a different name. Nothing
	// matches on the old spelling — teardown computes the name from the id it
	// just minted, in the same process — but it is a visible change in
	// `docker ps`.
	const random = Math.random().toString(36).slice(2, 10)
	return asSandboxId(`sbx_${Date.now().toString(36)}_${random}`)
}

async function waitForWorkerReady(
	baseUrl: string,
	timeoutMs: number,
	pollMs: number,
	signal?: AbortSignal,
): Promise<void> {
	const deadline = new OperationDeadline(timeoutMs, 'docker worker readiness', signal)
	let lastError: unknown
	while (deadline.remainingMs() > 0) {
		try {
			const result = await deadline.run((signal) => probeHttpHealth(`${baseUrl}/healthz`, signal))
			if (result.ok) return
			lastError = new Error(`healthz HTTP ${result.status}`)
		} catch (err) {
			lastError = err
			if (err instanceof OperationDeadlineExpired) break
		}
		try {
			await deadline.delay(pollMs)
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			throw err
		}
	}
	// A hint attached at the throw site, where the cause is actually known.
	// The container runtime's own message says a request failed; it cannot
	// say that the image may not be built or the daemon may not be running,
	// which is what a reader needs.
	throw withHint(
		new Error(
			`namzu-sandbox worker did not become ready within ${timeoutMs}ms: ${
				lastError instanceof Error ? lastError.message : String(lastError)
			}`,
		),
		'Check that the container runtime is running and that the sandbox worker image is built and reachable. A cold image pull can also exceed this window — raise the readiness timeout before assuming the worker is broken.',
	)
}

function runOnce(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted()
		const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		let settled = false
		const finish = (error?: unknown, value?: string) => {
			if (settled) return
			settled = true
			signal?.removeEventListener('abort', abort)
			child.removeAllListeners('error')
			child.removeAllListeners('close')
			if (error !== undefined) reject(error)
			else resolve(value ?? '')
		}
		const abort = () => {
			child.kill('SIGKILL')
			child.unref()
			finish(signal?.reason ?? new Error('operation aborted'))
		}
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf8')
		})
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8')
		})
		child.on('error', (error) => finish(error))
		child.on('close', (code) => {
			if (code === 0) finish(undefined, stdout.trim())
			else finish(new Error(`${binary} ${args.join(' ')} exited ${code}: ${stderr.trim()}`))
		})
		if (signal?.aborted) abort()
		else signal?.addEventListener('abort', abort, { once: true })
	})
}

/**
 * Read a network's `Internal` flag from the daemon.
 *
 * A network that does not exist, or a daemon that is down, comes back as the
 * empty string rather than throwing, so {@link assertNetworkCarriesThePolicy}
 * refuses it for the reason the caller actually cares about — "this is not
 * a boundary" — instead of surfacing a docker CLI error that says nothing
 * about the egress policy that prompted the lookup.
 */
async function inspectNetworkInternalFlag(
	docker: string,
	network: string,
	signal?: AbortSignal,
): Promise<string> {
	try {
		return await runOnce(
			docker,
			['network', 'inspect', '--format', '{{.Internal}}', network],
			signal,
		)
	} catch {
		signal?.throwIfAborted()
		return ''
	}
}

function runOnceQuiet(binary: string, args: string[], signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const child = spawn(binary, args, { stdio: 'ignore' })
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			signal?.removeEventListener('abort', abort)
			child.removeListener('error', finish)
			child.removeListener('close', finish)
			resolve()
		}
		const abort = () => {
			child.kill('SIGKILL')
			child.unref()
			finish()
		}
		child.on('error', finish)
		child.on('close', finish)
		if (signal?.aborted) abort()
		else signal?.addEventListener('abort', abort, { once: true })
	})
}

/**
 * Skill IDs are user-controlled strings that end up in the in-
 * container path (`/mnt/skills/<id>`) and on a `--volume` flag the
 * shell does not see (we use `spawn` argv, not a shell pipeline). So
 * the regex doesn't have to defend against shell metacharacters — it
 * exists to keep paths legible (no whitespace, no `..`, no slashes
 * to escape the `/mnt/skills` prefix). The set is the same shape git
 * accepts for ref names: alphanumerics, `_`, `-`, `.`. Letting `.`
 * through enables `pdf-tools.v2`-style versioning; rejecting `..`
 * specifically guards path traversal even though Docker's bind
 * resolution doesn't follow it.
 */
const SKILL_ID_REGEX = /^[a-zA-Z0-9_.-]+$/

/**
 * Validate and resolve a {@link ContainerSandboxLayout}. Returns a
 * {@link ResolvedContainerSandboxLayout} with every container path
 * filled in; throws {@link ContainerSandboxLayoutValidationError}
 * collecting every violation in one pass.
 *
 * Called once at provider construction (`createSandboxProvider`).
 * Validation surfaces synchronously during host wiring; nothing
 * downstream re-validates per `provider.create()` call.
 *
 * Exported for tests so the validation rules are pinned by golden-
 * value assertions rather than only exercised through the spawn path.
 */
export function resolveLayout(layout: ContainerSandboxLayout): ResolvedContainerSandboxLayout {
	const reasons: string[] = []

	// Outputs is required — without it the model has no place to
	// persist work past container teardown, and the worker has no
	// rooted workspace for its path resolver. The SDK type marks
	// outputs required too, but the public type can be circumvented
	// with `as` casts; runtime check is the contract.
	if (!layout.outputs) {
		reasons.push(
			'`outputs` is required (deliverables surface). Pass `layout.outputs.source = { type: "hostDir", hostPath: "..." }`.',
		)
	}

	// Skill IDs: regex + substring `..` reject + duplicate check.
	// Run even if `outputs` is missing so the consumer sees every
	// problem in one pass — fix-then-rerun loops at this layer are
	// cheap to avoid.
	//
	// Why the substring `..` reject on top of the regex: the regex
	// `[a-zA-Z0-9_.-]` legitimately allows `.` (so ids like
	// `pdf-tools.v2` work), but `..` (or any embedded `..` like
	// `foo..bar`) is a path-traversal segment that, when
	// interpolated into the default container path
	// `/mnt/skills/<id>`, lifts the bind out of the skills parent.
	// Reject any `..` substring outright — there is no legitimate
	// skill-id shape with consecutive dots.
	const skillIds = new Set<string>()
	if (layout.skills) {
		for (const skill of layout.skills) {
			if (!SKILL_ID_REGEX.test(skill.id)) {
				reasons.push(
					`skill id ${JSON.stringify(skill.id)} contains characters outside [a-zA-Z0-9_.-]`,
				)
			} else if (skill.id.includes('..')) {
				reasons.push(
					`skill id ${JSON.stringify(skill.id)} contains a path-traversal segment ('..')`,
				)
			} else if (skillIds.has(skill.id)) {
				reasons.push(`duplicate skill id ${JSON.stringify(skill.id)}`)
			} else {
				skillIds.add(skill.id)
			}
		}
	}

	// Resolve container paths now (before duplicate check) so
	// duplicate detection sees the actual mount targets, including
	// defaults applied when `containerPath` is omitted. Defaults
	// come from `@namzu/sdk`'s exported constants so a Vandal prompt
	// template generator and the backend agree on a single source of
	// truth.
	const resolvedOutputs = layout.outputs
		? {
				source: layout.outputs.source,
				containerPath: layout.outputs.containerPath ?? SANDBOX_DEFAULT_OUTPUTS_PATH,
			}
		: undefined
	const resolvedUploads = layout.uploads
		? {
				source: layout.uploads.source,
				containerPath: layout.uploads.containerPath ?? SANDBOX_DEFAULT_UPLOADS_PATH,
			}
		: undefined
	const resolvedScratch = layout.scratch
		? {
				source: layout.scratch.source,
				containerPath: layout.scratch.containerPath ?? SANDBOX_DEFAULT_SCRATCH_PATH,
			}
		: undefined
	const resolvedToolResults = layout.toolResults
		? {
				source: layout.toolResults.source,
				containerPath: layout.toolResults.containerPath ?? SANDBOX_DEFAULT_TOOL_RESULTS_PATH,
			}
		: undefined
	const resolvedTranscripts = layout.transcripts
		? {
				source: layout.transcripts.source,
				containerPath: layout.transcripts.containerPath ?? SANDBOX_DEFAULT_TRANSCRIPTS_PATH,
			}
		: undefined
	const resolvedSkills = layout.skills?.map((s) => ({
		id: s.id,
		source: s.source,
		containerPath: s.containerPath ?? `${SANDBOX_DEFAULT_SKILLS_PARENT}/${s.id}`,
	}))

	// Duplicate `containerPath` detection across every mount. Two
	// binds at the same path is a Docker error at the daemon level,
	// but the daemon's error surfaces inside the container creation
	// failure mode — much later, with less context. Catch it here.
	const containerPathOwners = new Map<string, string>()
	function track(label: string, p: string | undefined) {
		if (!p) return
		const prior = containerPathOwners.get(p)
		if (prior) {
			reasons.push(
				`duplicate containerPath ${JSON.stringify(p)} declared by both ${prior} and ${label}`,
			)
		} else {
			containerPathOwners.set(p, label)
		}
	}
	track('outputs', resolvedOutputs?.containerPath)
	track('uploads', resolvedUploads?.containerPath)
	track('scratch', resolvedScratch?.containerPath)
	track('toolResults', resolvedToolResults?.containerPath)
	track('transcripts', resolvedTranscripts?.containerPath)
	if (resolvedSkills) {
		for (const skill of resolvedSkills) {
			track(`skill:${skill.id}`, skill.containerPath)
		}
	}

	if (reasons.length > 0) {
		throw new ContainerSandboxLayoutValidationError(reasons)
	}

	// `outputs` presence was checked above; the non-null assertion is
	// safe because the validation throws on missing.
	const resolved: ResolvedContainerSandboxLayout = {
		// biome-ignore lint/style/noNonNullAssertion: validation enforces presence
		outputs: resolvedOutputs!,
		...(resolvedUploads ? { uploads: resolvedUploads } : {}),
		...(resolvedScratch ? { scratch: resolvedScratch } : {}),
		...(resolvedToolResults ? { toolResults: resolvedToolResults } : {}),
		...(resolvedTranscripts ? { transcripts: resolvedTranscripts } : {}),
		...(resolvedSkills && resolvedSkills.length > 0 ? { skills: resolvedSkills } : {}),
	}
	return resolved
}

/**
 * Render `--volume` flags for a {@link ResolvedContainerSandboxLayout}. Order
 * is stable (outputs rw, uploads ro, toolResults ro, skills ro,
 * transcripts ro) so the test golden values stay deterministic.
 *
 * Today every `ContainerSandboxMountSource` is `{ type: 'hostDir', hostPath }`.
 * When future variants land (squashfs / managed volumes), this
 * function gains a discriminator switch; the single-variant union
 * keeps tomorrow's exhaustiveness check honest by giving us a
 * `type` field to switch on without renaming the call sites.
 */
/**
 * Narrow a {@link ContainerSandboxMountSource} to the `hostDir`
 * variant for backends that only know how to bind-mount from a host
 * filesystem path (docker, podman, plain Firecracker virtio-fs). Any
 * other variant (e.g. `azureFileShare` consumed by the ACI backend)
 * is a hard configuration mismatch — throw at spawn time rather than
 * render a malformed `--volume` flag the daemon would reject with a
 * confusing message.
 */
function requireHostDir(
	source: ContainerSandboxLayoutMount['source'],
	label: string,
): { readonly hostPath: string } {
	if (source.type !== 'hostDir') {
		throw new Error(
			`docker backend cannot consume mount source type ${JSON.stringify(source.type)} for ${label}; expected 'hostDir'. The non-hostDir variants (e.g. 'azureFileShare') belong to managed-container backends.`,
		)
	}
	return source
}

export function renderLayoutMountArgs(layout: ResolvedContainerSandboxLayout): string[] {
	const args: string[] = []
	const outputs = requireHostDir(layout.outputs.source, 'outputs')
	args.push('--volume', `${outputs.hostPath}:${layout.outputs.containerPath}:rw`)
	if (layout.uploads) {
		const uploads = requireHostDir(layout.uploads.source, 'uploads')
		args.push('--volume', `${uploads.hostPath}:${layout.uploads.containerPath}:ro`)
	}
	if (layout.scratch) {
		// Scratch is RW so the agent can read its own intermediate
		// drafts back. It is NOT visible to the deliverables collector
		// because the host directory it binds is a sibling of, not a
		// child of, the outputs hostPath.
		const scratch = requireHostDir(layout.scratch.source, 'scratch')
		args.push('--volume', `${scratch.hostPath}:${layout.scratch.containerPath}:rw`)
	}
	if (layout.toolResults) {
		const toolResults = requireHostDir(layout.toolResults.source, 'toolResults')
		args.push('--volume', `${toolResults.hostPath}:${layout.toolResults.containerPath}:ro`)
	}
	if (layout.skills) {
		for (const skill of layout.skills) {
			const skillSrc = requireHostDir(skill.source, `skill ${skill.id}`)
			args.push('--volume', `${skillSrc.hostPath}:${skill.containerPath}:ro`)
		}
	}
	if (layout.transcripts) {
		const transcripts = requireHostDir(layout.transcripts.source, 'transcripts')
		args.push('--volume', `${transcripts.hostPath}:${layout.transcripts.containerPath}:ro`)
	}
	return args
}

export function renderLayoutReadRootsEnv(layout: ResolvedContainerSandboxLayout): string {
	const roots = [
		layout.outputs.containerPath,
		layout.uploads?.containerPath,
		layout.scratch?.containerPath,
		layout.toolResults?.containerPath,
		layout.transcripts?.containerPath,
		...(layout.skills?.map((skill) => skill.containerPath) ?? []),
	].filter((root): root is string => Boolean(root))
	return Array.from(new Set(roots)).join(':')
}

/**
 * Writable container roots. Only the RW mounts go here — uploads,
 * tool-results, transcripts, and skills are read-only and must stay
 * out of WRITE_ROOTS or the agent's `write`/`append` could clobber
 * source files the host considers immutable.
 */
export function renderLayoutWriteRootsEnv(layout: ResolvedContainerSandboxLayout): string {
	const roots = [layout.outputs.containerPath, layout.scratch?.containerPath].filter(
		(root): root is string => Boolean(root),
	)
	return Array.from(new Set(roots)).join(':')
}
