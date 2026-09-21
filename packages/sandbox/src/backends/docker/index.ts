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
 *  - Every call to the worker's control API carries the per-instance
 *    `NAMZU_SANDBOX_TOKEN` this backend mints at create time and
 *    injects into the container's environment; a worker the host did
 *    not create must be provisioned with its own. The worker requires
 *    it on every route but `/healthz`, and refuses to start at all if
 *    it has none and is bound to anything routable.
 *  - Outbound network from the worker is restricted by the network
 *    it is attached to (see {@link DockerBackendConfig.network}) and,
 *    for a host allowlist, by an egress proxy running as a sibling
 *    container on that same network — the only way its traffic reaches
 *    the internet, because the network is `--internal` and has no route
 *    off it. The proxy is a container on that subnet like any other, so
 *    it is not the sandbox's only reachable destination. The proxy
 *    environment the sandbox is given directs traffic; the topology is
 *    what confines it. See {@link assertNetworkCarriesThePolicy} and
 *    #398.
 *
 * The credential above is what a previous version of this docblock
 * claimed network placement alone provided. It said the worker "only
 * listens on loopback inside its own netns", which is false — the worker
 * binds every interface by default and has to, because a published
 * container port forwards to the container's interface address rather
 * than to its loopback, so a loopback-bound worker is unreachable through
 * the port this backend publishes. The boundary was the network the
 * container is attached to, and wanted a credential behind it.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

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
	type SandboxReadFileOptions,
	type SandboxStatus,
	type SandboxWalkFilesOptions,
	generateSandboxId,
	walkFilesViaExec,
	withHint,
} from '@namzu/sdk'
import type { BrokeredCredential } from '../../egress/index.js'
import { assertBrokeredCredentialsFitProfile } from '../../egress/profile-wiring.js'
import {
	type SandboxEgressProfile,
	SandboxEgressProfileError,
	egressProfileCoversEntry,
	egressProfileHasPorts,
} from '../../egress/profile.js'

import {
	ContainerSandboxLayoutValidationError,
	type EgressPolicy,
	type SandboxBackend,
	type SandboxBackendOptions,
} from '../../index.js'
import {
	HttpWorkerClient,
	WORKER_UNAUTHORIZED_HINT,
	workerAuthorization,
} from '../http-worker-client.js'
import {
	OperationDeadline,
	OperationDeadlineExpired,
	probeHttpHealth,
	resolveReadinessOptions,
	runFailureCleanup,
} from '../readiness.js'
import {
	RemoteCancellationUnknownError,
	RemoteProtocolError,
} from '../remote-execution-controller.js'

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
	 * Left unset by default because `--user` does not ADD a non-root user, it
	 * OVERRIDES the image's own choice of one. The reference image ends with
	 * `USER namzu` (uid 1001, its `/workspace` chowned to match), so this
	 * backend's default is already non-root for the image it ships — a
	 * hard-coded uid here would replace that with a guess, and the guess is
	 * wrong for any image whose files are owned by someone else, which
	 * surfaces as `EACCES` on a path the workload was told it could write.
	 * Set it when the image does not declare a user of its own, or when the
	 * host wants a different one than it declares.
	 */
	readonly runAsUser?: string

	/**
	 * CPU cores the container may use, rendered as `--cpus`. Unset by default.
	 *
	 * `--memory` and `--pids-limit` bound what a workload can take from the
	 * host, and CPU had no equivalent at all — no default, no knob — which
	 * reads as an oversight rather than a decision. It stays unset for the
	 * same reason neither of those two has a numeric default: the right value
	 * is a property of the host's machine and of what the workload is for, and
	 * any number this backend picked would silently throttle a run that
	 * finishes inside its timeout today. A host that wants the bound says what
	 * it is; the value is a decimal (`--cpus 1.5` is one and a half cores'
	 * worth of time, not a rounding).
	 *
	 * It lives on this config rather than beside `memoryLimitMb` on the
	 * per-call options because the documented deployment constructs one
	 * provider per task, so construction time IS per-task — and a control
	 * added to the tier-agnostic per-call shape would have to be refused by
	 * the ACI and kubernetes backends, which cannot apply a per-sandbox CPU
	 * limit any more than they can apply the memory and process ones.
	 */
	readonly cpuLimit?: number

	/**
	 * Mount the container's root filesystem read-only. Default `true`.
	 *
	 * See {@link HARDENING_ARGS} for why the default is on and
	 * {@link renderWritableRootfsArgs} for the paths that stay writable while
	 * it is. Set it to `false` to make every path inside the container
	 * writable again, which is what a host whose image writes somewhere the
	 * writable set cannot describe needs, and which is why the switch exists
	 * instead of an unwritten rule that the baseline is absolute. It turns off
	 * that one control and nothing else: `--cap-drop=ALL`,
	 * `--security-opt=no-new-privileges` and `--ipc private` are applied
	 * whatever this says. It is a config field rather than an argument so that
	 * turning it off is a line somebody wrote on purpose, and not the default
	 * anyone gets by not looking.
	 */
	readonly readOnlyRootfs?: boolean

	/**
	 * Extra paths to keep writable under `--read-only`, each mounted `--tmpfs`.
	 *
	 * The default set ({@link DEFAULT_WRITABLE_ROOTFS_PATHS}) is the reference
	 * image's needs, read off its Dockerfile; this is how a host that points
	 * `image` somewhere else says what ITS image needs, because the backend
	 * cannot read that out of an image and guessing is what these paths would
	 * otherwise be. A path the layout already mounts is refused rather than
	 * mounted twice (`Duplicate mount point`), and setting this at all beside
	 * `readOnlyRootfs: false` is refused as a contradiction.
	 */
	readonly writableRootfsPaths?: readonly string[]

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

	/**
	 * Image the egress proxy runs as, when the policy needs one.
	 *
	 * A host allowlist (`static` or `resolver`) is enforced by a proxy, and
	 * this backend no longer runs that proxy in its own process: it runs it as
	 * a sibling container, dual-homed between the sandbox's `--internal`
	 * network (where the sandbox can reach it, and nothing else) and an
	 * ordinary bridge (where it reaches the internet). See
	 * {@link renderEgressProxyRunArgs} for the argv and
	 * `egress-proxy/Dockerfile` for the image to build.
	 *
	 * It is a second image rather than a reuse of `image` on purpose, and the
	 * reason is deployment-shaped rather than hygienic: the sandbox image is a
	 * host-supplied string that this backend cannot read, so there is no way to
	 * know whether the image named there has the proxy module in it, and the
	 * bind-mount alternative breaks exactly on the remote-daemon deployment
	 * (`hostReachability: 'container-network'`) where the SDK's own filesystem
	 * is not the daemon's.
	 *
	 * Unset, an allowlist policy is REFUSED at `create()` rather than
	 * downgraded — the same rule the rest of this file applies to a policy it
	 * cannot enforce. `deny-all` and `allow-all` need no image.
	 */
	readonly egressProxyImage?: string

	/**
	 * Network the egress proxy joins for its route to the internet. Default
	 * `'bridge'`, docker's own default bridge.
	 *
	 * This is the proxy's second leg, and it exists because the internal
	 * network the sandbox sits on has no route out by design. `'bridge'` is
	 * the default because it always exists and always has NAT, which keeps a
	 * host's first allowlist policy working without a second network to
	 * create.
	 *
	 * **The default is also the one wart of this topology, and a host that
	 * shares a docker daemon should know it.** The proxy listens on every
	 * interface inside its own container, so any other container attached to
	 * the same network reaches it too — and this proxy enforces its allowlist
	 * for whoever asks and stamps brokered credentials on the requests it
	 * forwards. On `'bridge'` that means every container on the host's default
	 * bridge. Name a dedicated network here (one only this deployment's
	 * containers join) to decide who that is. There is deliberately no switch
	 * that narrows the listener instead: the container has no way to know
	 * which of its own interfaces is which, and a listener bound to the wrong
	 * one is a sandbox with no route out at all.
	 */
	readonly egressProxyUpstreamNetwork?: string

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
	 *
	 * They are applied to the egress proxy's container too, when one runs.
	 * That is deliberate in both directions: a reaper that collects a
	 * sandbox's containers should collect the proxy with them, and a proxy
	 * left running by a sandbox that died is a container holding real
	 * credentials with a route to the internet.
	 */
	readonly labels?: Readonly<Record<string, string>>

	/**
	 * The egress profile the provider was built with, already validated by
	 * `defineEgressProfile`. The create-time policy is derived from it by the
	 * provider; the backend reads it for what a policy cannot carry. Under a
	 * profile, a brokered credential for a host outside it is refused at
	 * construction, and a live `setNetworkPolicy` may only name hosts the
	 * profile covers.
	 */
	readonly egressProfile?: SandboxEgressProfile
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
	// Refused here rather than at the first spawn, so a config that cannot be
	// rendered — a CPU limit that cannot mean anything, or writable paths
	// beside a writable root filesystem — surfaces during host wiring instead
	// of as a container that failed to come up. The same checks run where the
	// argv is built, because that is the only place a caller cannot skip them.
	assertCpuLimitIsRenderable(config.cpuLimit)
	assertRootfsOptionsAreCoherent(config)
	if (config.egressProfile !== undefined) {
		assertBrokeredCredentialsFitProfile(
			config.egressProfile,
			config.brokeredCredentials,
			config.runtime === 'runsc' ? 'runsc' : 'docker',
		)
	}
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
 *
 * Every policy that returns the configured network depends on that same
 * assertion, which is why the two live side by side: this function says which
 * network the container joins, and that one refuses the network if it cannot
 * do what the policy asks of it (#398). An allowlist used to answer the
 * configured network and get a proxy environment variable pointed at a
 * host-side listener — enforcement by convention, which an uncooperative
 * process simply ignores.
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
				`The docker sandbox backend cannot enforce an egress policy of kind '${egress.kind}' without an egress proxy: it has nothing to filter hosts through. Name the image it should run the proxy as (egressProxyImage — see packages/sandbox/egress-proxy/Dockerfile), or use 'deny-all' / 'allow-all'. Refusing rather than silently granting full network access.`,
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

/**
 * Whether two allowlists are the same list: same hosts, same order, duplicates
 * kept. Deliberately not a set comparison. The proxy is handed the list as
 * written, and a reordered list is a different configuration even when it
 * permits the same hosts; the only cost of calling it different is one swap.
 */
function sameHostList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((host, index) => host === b[index])
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
 * Three requirements meet on the same object here, and the first two were
 * previously unstated — which is how the backend came to ship a default
 * configuration that could not create a sandbox at all:
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
 *  - **A host allowlist needs one too, for the same reason and with one
 *    addition.** Until #398 the allowlist tier answered the configured
 *    network and pointed the sandbox at a proxy running on the host's
 *    loopback, and the only thing making traffic go through it was
 *    `HTTP_PROXY`. That is a request, not a boundary: anything inside the
 *    container that opens a socket directly reaches the network with the
 *    allowlist unconsulted, and untrusted code is the caller least likely to
 *    honour a convention. With the proxy as a sibling container on an
 *    `--internal` network, the only way the sandbox's traffic reaches the
 *    internet is that container, and it cannot change that because
 *    `--cap-drop=ALL` took `NET_ADMIN` away (see {@link HARDENING_ARGS}). The
 *    environment variables stay and now DIRECT traffic rather than permit it.
 *    On a network that is not internal there is no such route to remove, and
 *    the policy is back to being advisory — which is what this refuses.
 *
 * The first two are exact opposites, so `deny-all` over a published host port
 * is impossible rather than merely unsupported: no arrangement of docker
 * networking both denies all egress and lets the host reach the worker over
 * TCP. Closing that needs the control channel moved off TCP — see #398 — and
 * is not a flag this function could accept. The same opposition now reaches
 * an allowlist policy, which is new: an allowlist on an internal network must
 * be reached by container name, so a host that used a published port with a
 * host allowlist has to move that consumer onto the internal network. That is
 * a consequence of the boundary existing at all and not a gap in this
 * function; the refusal below names the mode to move to.
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

	if (needsEgressProxy(egress) && !internal) {
		throw new Error(
			`The docker sandbox backend was asked for an egress policy of kind '${egress?.kind}' on network '${network}', but that network is not internal, so nothing stops the container from reaching the world directly and the allowlist would only be a proxy environment variable a workload may decline to read. Create the network with 'docker network create --internal ${network}': the sandbox then reaches the internet only through the egress proxy container, which is the boundary — and set hostReachability: 'container-network' to reach the worker by name on it, since a published host port needs a route out this network does not have. Refusing rather than reporting a boundary that is not there.`,
		)
	}
}

/**
 * What the proxy container is told, as a value.
 *
 * The boundary's whole configuration. It is a value for the reason
 * {@link resolveNetwork} is one: everything downstream of here needs a running
 * Docker daemon, so a credential that failed to reach the boundary could only
 * be caught by an operator noticing their requests arrive unauthenticated in
 * production. A knob a host sets and the boundary never receives is the
 * failure this shape exists to make testable.
 *
 * `parseProxyConfig` in `egress-proxy/server.mjs` refuses every shape in here
 * it cannot read — and this function's own output is fed to that parser by
 * `__tests__/hardening.test.ts`, so the two ends are pinned against each other
 * rather than each against its own idea of the shape. A field renamed on one
 * side alone fails a test rather than starting a boundary that enforces
 * something nobody wrote.
 */
export interface EgressProxyContainerConfig {
	readonly port: number
	readonly allowedHosts: readonly string[]
	readonly credentials: readonly BrokeredCredential[]
	readonly allowInwardFor?: readonly string[]
	/**
	 * Names that denote the proxy itself, for its loop guard. The container's
	 * own hostname is added to this by the entrypoint; this field carries the
	 * network alias, which is the name the sandbox actually dials.
	 */
	readonly selfNames?: readonly string[]
	/**
	 * The egress profile's rules, every one of them, when the profile carries
	 * ports. Present only then, and only in the V2 configuration
	 * ({@link EGRESS_PROXY_CONFIG_V2_ENV}): the proxy computes a host's
	 * allowed ports as the union over every rule that matches it, so a rule
	 * without ports is listed too.
	 */
	readonly hostPorts?: readonly { readonly host: string; readonly ports?: readonly number[] }[]
}

/**
 * Build the proxy container's configuration.
 *
 * `allowedHosts` is already resolved here rather than passed as a policy, and
 * that is the one behavioural difference this change carries into the
 * boundary: the in-process proxy called the host's resolver per request, and
 * the container cannot. A `resolver` policy that rotates is honoured at
 * `create()` and again at every `setNetworkPolicy()` — the container has no
 * channel back to the host's resolver, and a channel the container CAN reach
 * is one the sandbox can reach too, which would let the sandbox ask for its
 * own allowlist to be widened. See `docs/sdk/sandbox-egress.md`.
 */
export function egressProxyContainerConfig(
	config: Pick<
		DockerBackendInternalConfig,
		'brokeredCredentials' | 'allowInwardFor' | 'egressProfile'
	>,
	allowedHosts: readonly string[],
	port: number,
): EgressProxyContainerConfig {
	return {
		port,
		allowedHosts,
		credentials: config.brokeredCredentials ?? [],
		...(config.allowInwardFor ? { allowInwardFor: config.allowInwardFor } : {}),
		selfNames: [PROXY_HOST_ALIAS],
		...(usesPortRules(config) && config.egressProfile
			? { hostPorts: config.egressProfile.hosts }
			: {}),
	}
}

/**
 * Whether the proxy has port rules to enforce: a profile with at least one
 * rule that carries `ports`. Only then is the configuration sent as V2, and
 * only then is the image's label checked, so every other policy starts the
 * proxy with exactly the V1 configuration and argv it always had.
 */
export function usesPortRules(config: Pick<DockerBackendInternalConfig, 'egressProfile'>): boolean {
	return config.egressProfile !== undefined && egressProfileHasPorts(config.egressProfile)
}

/** The environment variable the proxy's configuration travels in. See {@link usesPortRules}. */
export function egressProxyConfigEnvName(
	config: Pick<DockerBackendInternalConfig, 'egressProfile'>,
): string {
	return usesPortRules(config) ? EGRESS_PROXY_CONFIG_V2_ENV : EGRESS_PROXY_CONFIG_ENV
}

/**
 * `--label key=value` flags, validated before they reach the daemon.
 *
 * An empty key or one containing `=` would silently produce a malformed label
 * that a downstream `docker ps --filter label=…` could not match, so misuse
 * surfaces during construction rather than as a container that mysteriously
 * has no labels.
 */
function renderLabelArgs(labels: Readonly<Record<string, string>> | undefined): string[] {
	const args: string[] = []
	if (!labels) return args
	for (const [key, value] of Object.entries(labels)) {
		if (!key || key.includes('=')) {
			throw new Error(`docker label key ${JSON.stringify(key)} is invalid (empty or contains '=')`)
		}
		args.push('--label', `${key}=${value}`)
	}
	return args
}

/**
 * Name the proxy container reads its configuration from.
 *
 * The NAME travels in the argv and the VALUE travels in the `docker` CLI
 * child's environment, which is why this is one constant used by both ends of
 * that pair rather than a literal written twice.
 */
const EGRESS_PROXY_CONFIG_ENV = 'NAMZU_EGRESS_PROXY_CONFIG'

/**
 * The V2 configuration, which adds port rules. Sent INSTEAD of the V1 one,
 * never beside it: an image that predates port rules reads only V1, finds it
 * unset and exits, so it fails closed rather than enforcing hosts without
 * ports. `egress-proxy/server.mjs` is the reader.
 */
export const EGRESS_PROXY_CONFIG_V2_ENV = 'NAMZU_EGRESS_PROXY_CONFIG_V2'

/**
 * The image label saying which configuration version the proxy image reads.
 * `egress-proxy/Dockerfile` sets it to `2`. Checked with `docker image
 * inspect` before a proxy with port rules is started, because the other
 * signal, the container exiting, can arrive after the readiness check has
 * already passed.
 */
export const EGRESS_PROXY_IMAGE_CONFIG_LABEL = 'ai.namzu.egress-proxy.config'

/** Everything {@link renderEgressProxyRunArgs} renders, as a value. */
export interface EgressProxyArgvInput {
	readonly config: DockerBackendInternalConfig
	readonly containerName: string
	/** Network the proxy reaches the internet through. See `egressProxyUpstreamNetwork`. */
	readonly upstreamNetwork: string
	/** The internal network the sandbox is on, which the proxy is also joined to. */
	readonly internalNetwork: string
}

/**
 * The `docker run` argv for the egress proxy container, as a value.
 *
 * Extracted for the reason every other argv in this file is: nothing
 * downstream of it can run without a docker daemon, so a flag that never
 * reached it — or a `--network` that named the wrong side of a dual-homed
 * container — could only be caught by an operator in production, where the
 * symptom is a sandbox that reaches nothing.
 *
 * The two networks are the whole topology and they are two calls:
 * `docker run --network <upstream>` gives the container a default route, and
 * {@link renderEgressProxyAttachArgs}'s `docker network connect` adds the
 * internal network afterwards. The order is load-bearing. Attached to the
 * internal network FIRST it would come up with no default route and no way to
 * acquire one, and the proxy would be a boundary in front of nothing.
 *
 * The hardening baseline is the sandbox's, minus the parts that describe a
 * filesystem. `--cap-drop=ALL`, `--no-new-privileges` and `--ipc private` are
 * applied exactly as {@link HARDENING_ARGS} defines them, because this
 * container sits between untrusted code and the internet and is the last one in
 * the deployment that should be holding a capability. `--read-only` is the
 * sandbox's too, with one tmpfs: the proxy writes nothing, and the tmpfs is
 * there so that a Node process which one day wants a temp file fails at a
 * filesystem boundary rather than at a mysterious `EROFS`.
 *
 * The image is last, so nothing after it is read as a flag — the same rule the
 * sandbox argv follows, and here it also means the image's own `CMD` starts the
 * proxy rather than this argv naming an entrypoint.
 */
export function renderEgressProxyRunArgs(input: EgressProxyArgvInput): string[] {
	const { config, containerName, upstreamNetwork, internalNetwork } = input
	if (!config.egressProxyImage) {
		throw new Error(
			'renderEgressProxyRunArgs was called without config.egressProxyImage; the docker backend cannot start an egress proxy container it has no image for. resolveNetwork refuses an allowlist policy in this state, so reaching here means the refusal was bypassed.',
		)
	}
	if (upstreamNetwork === 'none') {
		throw new Error(
			`egressProxyUpstreamNetwork is 'none', which would give the proxy container no interface and no route: it would come up unable to reach anything, and the only way the sandbox's traffic reaches the internet would be a boundary that cannot reach it itself. Name a bridge, or drop the field to take the 'bridge' default.`,
		)
	}
	if (upstreamNetwork === internalNetwork) {
		throw new Error(
			`egressProxyUpstreamNetwork names '${upstreamNetwork}', which is the same network the sandbox is on — the internal one. A container whose primary network is internal comes up with no default route and never acquires one, so the proxy would start with no way to reach the internet: the boundary would be a container that can only talk to the sandbox. Name a different network for egressProxyUpstreamNetwork, or drop the field to take the 'bridge' default.`,
		)
	}
	return [
		'run',
		'--detach',
		'--rm',
		'--name',
		containerName,
		// The name the sandbox dials, and the name the proxy's own loop guard
		// has to recognise as itself. Set as the container's hostname so the
		// entrypoint can read it back with `os.hostname()` instead of holding a
		// second copy of the constant.
		'--hostname',
		PROXY_HOST_ALIAS,
		'--network',
		upstreamNetwork,
		...HARDENING_ARGS,
		'--read-only',
		'--tmpfs',
		`/tmp:${TMPFS_MOUNT_OPTIONS}`,
		...renderLabelArgs(config.labels),
		// The NAME only: docker takes the value from the environment of the
		// `docker` CLI process it names, which the caller sets (see
		// `startEgressProxyContainer`). The value is the whole policy —
		// including brokered credential values — and an argv is a worse place
		// for it than an environment on every platform that has a process
		// table: `/proc/<pid>/cmdline` is world-readable on Linux, so putting
		// it here published it to every local user on the docker host for as
		// long as the client ran, where the child's own environment is readable
		// only by the user that owns the process. It is still readable by
		// anything with access to the daemon, through `docker inspect`, and
		// `docs/sdk/sandbox-egress.md` says so.
		'--env',
		egressProxyConfigEnvName(config),
		config.egressProxyImage,
	]
}

/**
 * The `docker network connect` argv that makes the proxy dual-homed.
 *
 * `--alias` is what puts `namzu-egress` in the internal network's DNS, which
 * is the name {@link buildDockerRunArgs} hands the sandbox in its proxy
 * environment. The alias rather than the container name because the alias is
 * the constant: a container named `namzu-egress-<sandbox-id>` would otherwise
 * make the sandbox's `HTTP_PROXY` value depend on a generated id, and the two
 * would have to be kept in step by hand.
 */
export function renderEgressProxyAttachArgs(input: EgressProxyArgvInput): string[] {
	return [
		'network',
		'connect',
		'--alias',
		PROXY_HOST_ALIAS,
		input.internalNetwork,
		input.containerName,
	]
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
 * `--cap-drop=ALL` is deliberately not softened by a re-add list, and there is
 * no config field that could soften it either: a workload that genuinely needs
 * a capability needs a change to this file, where the diff says which
 * capability and why. A re-add list on the config would grant it to every
 * sandbox the host spawns, quietly, which is how a baseline stops being one.
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
 *
 * `--ipc private` closes a door that is not the one its name suggests, and the
 * difference is worth being exact about. Moby runs `private`, `shareable` and
 * `none` through the SAME branch (`daemon/oci_linux.go`, `WithNamespaces`), so
 * `shareable` already gives every container an IPC namespace of its own: a
 * daemon whose `default-ipc-mode` is `shareable` does not merge anybody's
 * namespaces, and what an unset flag buys on such a daemon is not a shared one
 * either. What separates the modes is reachability. Docker's run reference
 * defines `shareable` as "Own private IPC namespace, with a possibility to
 * share it with other containers", and that possibility is `--ipc
 * container:<name>`, which joins another container's IPC namespace — and what
 * that join needs from the target is a shared-memory directory to enter:
 * `daemon.getIPCContainer` resolves the target by name and is gated on its
 * `ShmPath`, which a container created `private` does not have. So on a
 * daemon defaulting to `shareable` this container's namespace, and the System V
 * shared memory, semaphores and message queues namespaced with it, are joinable
 * by anything else on that host which knows the container's name; `--ipc
 * private` removes that reachability. Creating the joining container still takes
 * access to the same daemon, so this is not a boundary against an unprivileged
 * attacker, and it is not claimed as one here. What it buys is that the answer
 * is in THIS argv rather than in the host's `daemon.json`, which is the only
 * place the daemon's default is written down. `--ipc none` is deliberately not
 * used: it takes `/dev/shm` away, and chromium — which the reference image
 * ships for browser automation — uses it for every renderer process.
 *
 * `--read-only` makes the image itself not a place the workload can write. It
 * is rendered by {@link renderHardeningArgs} rather than listed below, because
 * it is the one flag here a host can turn off (`readOnlyRootfs: false`), and a
 * flag in this array would keep being applied after the field said it was not —
 * a control accepted and not applied, which is the failure this file refuses
 * everywhere else. The layout's own RW binds (`outputs`, `scratch`) are
 * separate mounts and are unaffected; what stays writable inside the
 * container's filesystem is named, path by path and with the reason, in
 * {@link renderWritableRootfsArgs}. A host whose image needs a path that list
 * does not name adds it through `writableRootfsPaths`.
 *
 * Three controls from the published container-hardening guidance are
 * deliberately absent, and the reason is here rather than implied:
 *
 *  - **A seccomp profile.** Docker already applies its built-in profile to
 *    every container unless something passes `seccomp=unconfined`, and nothing
 *    in this backend does — so the tier is filtered, and what is missing is a
 *    profile TIGHTER than docker's default. Shipping one means shipping a
 *    hand-written file whose deny list has to be correct for whatever image
 *    the host names, and this repository cannot test it against the reference
 *    image's own toolchain (chromium, LibreOffice, the numpy/scipy/duckdb
 *    stack). A profile that blocks a syscall one of those needs breaks the
 *    sandbox at a point no test here would catch, which is worse than the gap
 *    it closes. A host that needs a tighter profile sets `seccomp-profile` in
 *    the daemon's `daemon.json`, where it applies to this container and every
 *    other one; `--security-opt seccomp=<file>` is the per-container form, and
 *    it is not offered as a config field because a path in a config field is a
 *    file the daemon reads from the HOST, which is a different machine from
 *    the one this backend runs on whenever it drives a remote daemon.
 *  - **`--userns-remap`.** It is not a `docker run` flag at all: it is a
 *    daemon property (`userns-remap` in `daemon.json`, or `dockerd
 *    --userns-remap=`), and per container the CLI only chooses between the
 *    namespaces the daemon already made (`--userns=host|private`). Whether a
 *    remapped namespace exists is therefore settled before this argv is read,
 *    and a flag here could not settle it — which is the whole reason the
 *    control is absent rather than configurable: this backend has nothing to
 *    say about a mapping that belongs to the machine the daemon runs on.
 *    Enabling it on the host is a real upgrade to this tier (uid 0 inside maps
 *    to an unprivileged uid outside) and costs this backend nothing; the README
 *    says so.
 *  - **`--user`.** Supported, and unset by default on purpose — see the
 *    `runAsUser` field, which is where a host that knows its image sets it.
 */
const HARDENING_ARGS: readonly string[] = [
	'--cap-drop=ALL',
	'--security-opt=no-new-privileges',
	'--ipc',
	'private',
]

/**
 * Name the sandbox reaches the egress proxy by.
 *
 * This used to be a `--add-host namzu-egress:host-gateway` entry, because the
 * proxy ran on the host's loopback and `host-gateway` is docker's portable
 * name for the host from inside a container. It is now the proxy's own
 * container name and network alias on the internal network, which needs no
 * alias file at all: docker's embedded DNS resolves a container's aliases for
 * every container on the same user-defined network. The constant survives the
 * mechanism because what the sandbox is told has not changed — only what makes
 * the name resolve, and whether anything else can be reached.
 */
const PROXY_HOST_ALIAS = 'namzu-egress'

/**
 * Port the egress proxy listens on inside its own container.
 *
 * A fixed port rather than one the host reads back, because there is no host
 * port involved: the sandbox dials the proxy container directly on the network
 * they share. The old arrangement had to read a published port back out of
 * `docker inspect`, with the race and the failure mode that came with it.
 */
const EGRESS_PROXY_PORT_INSIDE_CONTAINER = 2025

/** Name of the sibling container the egress proxy runs in, for one sandbox. */
function egressProxyContainerName(sandboxId: string): string {
	return `${PROXY_HOST_ALIAS}-${sandboxId}`
}

/**
 * Mount options for every scratch mount this backend creates.
 *
 * `exec` is the load-bearing one and the reason this is a named constant
 * rather than a literal at the call site. Docker does NOT default a `--tmpfs`
 * mount to a usable scratch directory: `withMounts` in moby's
 * `daemon/oci_linux.go` starts every user tmpfs from
 * `["noexec", "nosuid", "nodev", <propagation>]` and appends whatever the
 * caller passed, so `--tmpfs /tmp` on its own is **noexec**. A workload that
 * compiles a program into `/tmp` and runs it — `gcc -o /tmp/a.out … &&
 * /tmp/a.out`, or a python `ctypes.CDLL` of a library it just built there —
 * would meet `Permission denied` on an executable file, an error that reads
 * as a broken sandbox rather than as a mount option. Scratch here is as
 * executable as it was before this backend mounted a tmpfs over it.
 *
 * `nosuid` and `nodev` are kept from docker's defaults: the tmpfs is the one
 * place inside the container a workload can write an arbitrary file to, and
 * neither a setuid binary nor a device node there has any use that is worth
 * the escalation path — with `--cap-drop=ALL` no device node could be created
 * there anyway.
 *
 * `mode=1777` is stated rather than inherited from the kernel's tmpfs default
 * (which is the same value): the mounts have to be writable by whichever uid
 * the image runs as, and the backend does not know that uid. A sticky,
 * world-writable scratch directory is what `/tmp` is, and `--read-only` here
 * is about the image, not about the uid.
 */
const TMPFS_MOUNT_OPTIONS = 'nosuid,nodev,exec,mode=1777'

/**
 * Paths the reference image needs writable under `--read-only`, as `--tmpfs`.
 *
 * `--read-only` says the image is not the workload's disk. It does not say
 * nothing may be written, and the difference is the sandbox: the layout's own
 * RW binds (`outputs`, `scratch`) are separate mounts and are unaffected, but
 * the image's toolchain writes inside the container's own filesystem, and a
 * `--read-only` that stops it is worse than the gap it closes. Read off
 * `worker/Dockerfile`, whose whole purpose is producing DOCX/XLSX/PPTX/PDF
 * deliverables:
 *
 *  - `/tmp` — `TMPDIR` for python's `tempfile`, for LibreOffice's extraction
 *    and for pip's wheel builds, and the conventional place to build and run
 *    something disposable. Every scratch mount takes
 *    {@link TMPFS_MOUNT_OPTIONS}, which is where the `exec` docker would not
 *    have given us is argued for.
 *  - `/var/tmp` — the second location the temp-file conventions fall back to,
 *    for a temp file that is meant to outlive an interrupted run.
 *  - `/home/namzu` — the image's `HOME` (`useradd --create-home namzu`, uid
 *    1001; docker sets `HOME` from the image's passwd entry). LibreOffice
 *    refuses a headless conversion without a writable user profile
 *    (`~/.config/libreoffice`), matplotlib builds a font cache in
 *    `~/.cache/matplotlib`, fontconfig keeps a user cache, npm's cache is
 *    `~/.npm`, and `pip install --user` needs `~/.local`.
 *  - `/workspace` — the image's `WORKDIR`, chowned to `namzu` on purpose
 *    (`chown -R namzu:namzu /workspace`). Leaving it out would make the
 *    Dockerfile's own guarantee false.
 *
 * These four are the REFERENCE image's needs, not a claim about anyone else's.
 * A host that points `image` at its own build names what that image needs in
 * `writableRootfsPaths`, which is why the field exists at all: the backend
 * cannot read an image's writable set, and the alternative to asking is
 * guessing. A path a root-running image wants (its `HOME` is `/root`) is a
 * `writableRootfsPaths` entry for exactly that reason — `/root` is not in this
 * list, because the shipped image does not run as root and a tmpfs nobody
 * writes to is a claim that something does.
 *
 * A path the LAYOUT already mounts is skipped rather than mounted twice:
 * docker refuses two mounts at one destination (`Duplicate mount point`), and
 * the bind the host asked for is the one that must win. A path the HOST names
 * that the layout also mounts is refused instead of skipped, because there the
 * two requests contradict each other and nothing should choose between them
 * silently.
 *
 * No `size=` is set. The kernel caps a tmpfs at half the host's RAM, and tmpfs
 * pages are accounted to the container's memory cgroup, so a run that sets
 * `--memory` already bounds scratch with the limit the host chose — while any
 * number picked here would fail a workload that writes a bigger temp file than
 * we guessed, with `ENOSPC` rather than a diagnosis.
 *
 * **The other half of that trade, said out loud because a host will meet it.**
 * Scratch now lives in RAM instead of on the container's writable layer, so a
 * temp file larger than half the host's RAM — or larger than `--memory`, which
 * is the tighter of the two whenever the host set one — fails with `ENOSPC` or
 * is OOM-killed, where writing it to disk used to succeed. That is the cost of
 * not leaving the root filesystem writable, and it is not a bug to be reported.
 * The remedy that keeps the baseline is the layout's own `scratch`, which is a
 * bind to a host directory and therefore still disk-backed: a host with room on
 * disk gives the layout one there and points `TMPDIR` at its container path
 * through the per-call `env` option, so the spill lands on that disk instead of
 * on a tmpfs. `readOnlyRootfs: false` is the other way, and the one to reach for
 * second: it puts scratch back on the container's writable layer and gives up
 * the rest of the baseline with it.
 */
const DEFAULT_WRITABLE_ROOTFS_PATHS: readonly string[] = [
	'/tmp',
	'/var/tmp',
	'/workspace',
	'/home/namzu',
]

/** The backend config the hardening flags are rendered from. */
export type DockerHardeningConfig = Pick<
	DockerBackendInternalConfig,
	'cpuLimit' | 'layout' | 'readOnlyRootfs' | 'writableRootfsPaths'
>

/**
 * The spelling docker compares a container path by.
 *
 * Docker cleans a mount destination before it uses it, so `/tmp/`, `//tmp` and
 * `/tmp/.` are one directory to it and to the kernel. The check below is an
 * exact-string comparison, so without this a layout that spelled one of its
 * mounts any of those ways would not match the tmpfs default at the same
 * directory: the argv would carry both a `--tmpfs /tmp:...` and a bind at
 * `/tmp/`, and moby would clean the two destinations into one and refuse the
 * container at spawn with `Duplicate mount point: /tmp` — the failure the check
 * exists to prevent, on the one path no test in this repository can reach.
 * `resolveLayout` does not normalise these (it fills in defaults and compares
 * spellings as written), so the cleaning has to happen here, where the
 * comparison does.
 */
function cleanContainerPath(path: string): string {
	const kept: string[] = []
	for (const segment of path.split('/')) {
		// Empty segments are `//`, `.` is the directory itself; `..` cancels the
		// segment before it, which is what the kernel does with it too.
		if (segment === '' || segment === '.') continue
		if (segment === '..') kept.pop()
		else kept.push(segment)
	}
	return `/${kept.join('/')}`
}

/**
 * Every destination the layout mounts something at, in the spelling docker
 * itself compares them by.
 *
 * The collision check below is exact-string, so a layout path spelled `/tmp/`
 * would slip past it and docker would then refuse the container with
 * `Duplicate mount point` — a failure at spawn, on the one path that cannot be
 * tested without a daemon. Cleaning each path to the spelling moby reduces it
 * to is what makes the check cover every way of writing the same directory;
 * see {@link cleanContainerPath}.
 */
function mountedContainerPaths(layout: ResolvedContainerSandboxLayout): string[] {
	return [
		layout.outputs.containerPath,
		layout.uploads?.containerPath,
		layout.scratch?.containerPath,
		layout.toolResults?.containerPath,
		layout.transcripts?.containerPath,
		...(layout.skills?.map((skill) => skill.containerPath) ?? []),
	]
		.filter((path): path is string => Boolean(path))
		.map(cleanContainerPath)
}

/**
 * Refuse rootfs options that cannot both be honoured.
 *
 * `writableRootfsPaths` beside `readOnlyRootfs: false` is a contradiction: with
 * a writable root filesystem every path is already writable, so the tmpfs
 * mounts would either be dropped (a control accepted and not applied) or take a
 * directory off the image for no reason. Refusing is the honest answer, and it
 * is the same one the sibling backends give a per-sandbox control they cannot
 * express.
 *
 * Called at construction and again where the argv is built, so a config that
 * reaches `create()` by some path other than `buildDockerBackend` is refused
 * too.
 */
export function assertRootfsOptionsAreCoherent(config: DockerHardeningConfig): void {
	const paths = config.writableRootfsPaths
	if (config.readOnlyRootfs !== false || paths === undefined || paths.length === 0) return
	throw new Error(
		'writableRootfsPaths was set on a docker backend configured with readOnlyRootfs: false. With a writable root filesystem every path inside the container is already writable, so these --tmpfs mounts would add nothing and take the named directories off the image. Refusing rather than accepting a control that cannot be applied: drop the paths, or drop readOnlyRootfs: false and let the read-only baseline stand.',
	)
}

/**
 * Refuse a `--cpus` value that cannot mean what it says.
 *
 * This covers non-finite and non-positive values and does NOT claim to cover
 * every bound the daemon would refuse. The difference is worth stating, because
 * the two classes fail in different places and only one of them is decidable
 * here. A negative, `NaN` or `Infinity` renders into the argv as text the
 * daemon either rejects or turns into a bound nobody asked for, and `0` is the
 * opposite of a bound (`NanoCPUs` of zero is how a container says "no CPU
 * limit"), so a host that wrote one of those hears about it during wiring
 * rather than as a container that never came up.
 *
 * The upper bound is not ours to check. Moby's `verifyPlatformContainerResources`
 * refuses `NanoCPUs` above the DAEMON host's CPU count (`"range of CPUs is from
 * 0.01 to N.00, as there are only N CPUs available"`), and the same function
 * deliberately sets no floor of its own on Linux, leaving that to the kernel.
 * Neither number is knowable from here: the `docker` binary this backend drives
 * can be pointed at a daemon on another machine (`DOCKER_HOST`), and even
 * locally `os.cpus().length` is this machine's view rather than the daemon's
 * own `runtime.NumCPU()`. Refusing on a guess at it would break a host whose
 * daemon has more cores than the process driving it, which is a worse failure
 * than the one it would catch — those arrive from the daemon with its own
 * message, at spawn, where every other daemon-side refusal arrives too.
 */
export function assertCpuLimitIsRenderable(cpuLimit: number | undefined): void {
	if (cpuLimit === undefined) return
	if (!Number.isFinite(cpuLimit) || cpuLimit <= 0) {
		throw new Error(
			`cpuLimit must be a finite number greater than 0 (docker's --cpus takes a decimal, e.g. 1.5); got ${String(cpuLimit)}. Refusing rather than rendering an argv whose value means something other than what was written.`,
		)
	}
}

/**
 * `--tmpfs` flags for the paths that stay writable under `--read-only`.
 *
 * See {@link DEFAULT_WRITABLE_ROOTFS_PATHS} for the paths themselves and why
 * each is there. Returns nothing when the read-only root filesystem is off, and
 * the two ways a host names paths that cannot be mounted — a contradiction with
 * `readOnlyRootfs: false`, or a path the layout already mounts — are refusals
 * rather than a silently shorter list.
 */
export function renderWritableRootfsArgs(config: DockerHardeningConfig): string[] {
	assertRootfsOptionsAreCoherent(config)
	if (config.readOnlyRootfs === false) return []

	const mounted = new Set(mountedContainerPaths(config.layout))
	const requested = config.writableRootfsPaths ?? []
	for (const path of requested) {
		// Every segment non-empty and none of them `.` or `..`: an absolute path
		// with at least one component. Anything else is refused because each
		// rejected shape is a directory this file's exact-string checks could
		// hold two spellings of — `/tmp/`, `//tmp` and `/tmp/.` are all `/tmp` to
		// the kernel, so a default that mounted `/tmp` and a host entry that
		// mounted `/tmp/` would each pass the duplicate-mount check and then be
		// refused by docker at spawn, on the one path no test here can reach.
		// `/` itself is refused as well, and for its own reason: it would make
		// the whole read-only root filesystem writable again.
		const segments = path.split('/')
		const wellFormed =
			path.startsWith('/') &&
			segments.length > 1 &&
			segments.slice(1).every((segment) => segment !== '' && segment !== '.' && segment !== '..')
		if (!wellFormed) {
			throw new Error(
				`writableRootfsPaths entry ${JSON.stringify(path)} is not a normalised absolute path inside the container. Docker requires an absolute mount path with no empty, '.' or '..' segment and no trailing slash, and '/' would make the whole filesystem writable again rather than adding a scratch directory.`,
			)
		}
		if (mounted.has(path)) {
			throw new Error(
				`writableRootfsPaths names ${path}, which this layout already mounts. Docker refuses two mounts at one destination ("Duplicate mount point"), so which one won would be decided by argument order rather than by anyone's intent. Drop the entry, or change the layout's own mount to the mode you want.`,
			)
		}
	}

	// The set collapses a host entry that repeats a default, which would
	// otherwise emit the same destination twice and be refused by docker.
	const paths = [
		...new Set([
			...DEFAULT_WRITABLE_ROOTFS_PATHS.filter((path) => !mounted.has(path)),
			...requested,
		]),
	]
	return paths.flatMap((path) => ['--tmpfs', `${path}:${TMPFS_MOUNT_OPTIONS}`])
}

/**
 * The confinement preamble for one container, in argv order.
 *
 * A function rather than a bare constant because `--read-only` is switchable
 * and the flags that follow it describe what stays writable while it is on:
 * `readOnlyRootfs: false` removes both the flag and the mounts. That is the only
 * thing it removes. Everything in {@link HARDENING_ARGS} is applied
 * unconditionally and no field can turn one of those off, so the argv for
 * `readOnlyRootfs: false` is the argv this backend produced before any of this
 * existed PLUS `--ipc private` — those two flags are the whole previous argv,
 * and `--ipc private` is now unconditional. `--ipc` is not folded under this
 * switch, because the field names the root filesystem: a host that turned the
 * read-only rootfs off would be turning IPC isolation off as well, silently,
 * for a reason the name of the field does not say. A switch has to mean one
 * thing.
 */
export function renderHardeningArgs(config: DockerHardeningConfig): string[] {
	return [
		...HARDENING_ARGS,
		...(config.readOnlyRootfs === false ? [] : ['--read-only']),
		...renderWritableRootfsArgs(config),
	]
}

/**
 * Everything {@link buildDockerRunArgs} renders, as a value.
 *
 * The pieces that come from the daemon or from the host are inputs rather than
 * lookups: which network the container attaches to, and whether an egress proxy
 * is listening and on which port. Both are already resolved by the caller, and
 * reading them here would put a daemon call back inside the function whose
 * whole point is that it needs none.
 */
export interface DockerRunArgvInput {
	readonly config: DockerBackendInternalConfig
	readonly options: SandboxBackendOptions
	readonly containerName: string
	readonly network: string
	readonly hostReachability: 'host-port' | 'container-network'
	/**
	 * Port the egress proxy listens on, when one is running. Absent means no
	 * proxy, and no proxy environment is passed in — which is not the same
	 * fact as a proxy that was configured and is unreachable.
	 *
	 * It is the proxy CONTAINER's port, on the internal network the two
	 * containers share; nothing is published on the host any more.
	 */
	readonly egressProxyPort?: number
}

/**
 * The complete `docker run` argv, as a value.
 *
 * Extracted for the same reason {@link resolveNetwork} and
 * {@link egressProxyContainerConfig} were: everything downstream of it needs a running
 * Docker daemon, so a confinement flag that never reached the argv — or one
 * that reached it in an order that cancels another — could only be caught by an
 * operator noticing its effect missing in production. Spawning a fake `docker`
 * and reading back what it was handed proves what the fake was told and nothing
 * about the container the daemon would build. Here the whole baseline is one
 * array, and an edit that drops a flag fails a test rather than a deployment.
 *
 * Order matters in exactly two places, and both are asserted by the test that
 * pins this: the image is the last argument, because everything after it is a
 * command for the container rather than a flag for docker; and every flag that
 * takes a value is pushed as two argv entries rather than one string, so no
 * value is ever re-split by anything downstream.
 */
export function buildDockerRunArgs(input: DockerRunArgvInput): string[] {
	const { config, options, containerName, network, hostReachability, egressProxyPort } = input
	const layout = config.layout
	assertRootfsOptionsAreCoherent(config)
	assertCpuLimitIsRenderable(config.cpuLimit)

	const args: string[] = [
		'run',
		'--detach',
		'--rm',
		'--name',
		containerName,
		'--network',
		network,
		...renderHardeningArgs(config),
	]
	if (config.runAsUser) {
		args.push('--user', config.runAsUser)
	}

	args.push(...renderLabelArgs(config.labels))

	args.push(...renderLayoutMountArgs(layout))
	// Forward only the workspace root so the worker's lexical
	// resolver agrees with the bind target. The full layout used
	// to ride along as `NAMZU_SANDBOX_LAYOUT`, but the worker
	// never branched on it; the manifest's only consumer was a
	// log line. A skill loader that needs the manifest will
	// write it to a bind path the worker reads at startup —
	// avoids env-size limits, keeps the wire shape minimal.
	if (egressProxyPort !== undefined) {
		// No `--add-host`, and no `host-gateway`. The proxy is a container on
		// this container's own internal network and `PROXY_HOST_ALIAS` is its
		// network alias there (see {@link renderEgressProxyAttachArgs}), which
		// docker's embedded DNS resolves with no alias file involved. The alias
		// entry this replaced pointed at the host's loopback, where the proxy
		// used to run — and a name resolving to a host that is not on this
		// network is exactly the route this change removes.
		const proxyUrl = `http://${PROXY_HOST_ALIAS}:${egressProxyPort}`
		// Both spellings: tooling is split between them, and a workload that
		// reads only the one that is missing loses the redirection.
		//
		// **These are convenience, not the boundary, and that is the point of
		// the arrangement.** A tool that honours them sends its requests to the
		// proxy; a tool that ignores them — a Go or Rust binary that does not
		// read proxy env, `curl --noproxy '*'`, a raw socket — has nowhere to
		// send anything. This container is on an `--internal` network with no
		// default route, and the only host on it is the proxy, so the
		// uncooperative path fails with `Network unreachable` rather than
		// bypassing the allowlist. What makes that true is
		// {@link assertNetworkCarriesThePolicy} refusing a network that is not
		// internal, not this block of environment.
		for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) {
			args.push('--env', `${key}=${proxyUrl}`)
		}
		// Loopback must not be proxied, or the worker cannot talk to
		// itself.
		args.push('--env', 'NO_PROXY=localhost,127.0.0.1')
		args.push('--env', 'no_proxy=localhost,127.0.0.1')
	}

	// `outputs` is required by validation, so its containerPath is always
	// available — the worker uses it as its workspace root.
	args.push('--env', `NAMZU_SANDBOX_WORKSPACE=${layout.outputs.containerPath}`)
	args.push('--env', `NAMZU_SANDBOX_READ_ROOTS=${renderLayoutReadRootsEnv(layout)}`)
	args.push('--env', `NAMZU_SANDBOX_WRITE_ROOTS=${renderLayoutWriteRootsEnv(layout)}`)

	// Only publish a host port when the consumer is going to reach
	// the worker through the docker host's loopback (CLI / direct
	// dev). For `container-network` reachability we leave the port
	// unpublished — sibling containers reach the worker by its DNS
	// name on the shared bridge, no host port required.
	//
	// Let Docker pick the host port instead of pre-reserving one
	// in this process. The reservePort()-then-publish-fixed-port
	// pattern had a TOCTOU window: the OS could hand the port to
	// another process between our `server.close()` and Docker's
	// `bind()`. Letting Docker pick (`--publish-all`) and reading
	// the mapping back via `docker inspect` removes the race.
	if (hostReachability === 'host-port') {
		args.push('--publish', `127.0.0.1::${WORKER_PORT_INSIDE_CONTAINER}`)
	}

	if (config.runtime) {
		args.push('--runtime', config.runtime)
	}

	// The three bounds the host can set, together and in one order, so a
	// reader of a `docker inspect` sees them side by side. `--memory` and
	// `--pids-limit` keep their existing treatment (a non-positive or absent
	// value means "not set"); `--cpus` refuses a value that would mean
	// something else, which is why it is the one with a check in front of it.
	if (options.memoryLimitMb && options.memoryLimitMb > 0) {
		args.push('--memory', `${options.memoryLimitMb}m`)
	}
	if (options.maxProcesses && options.maxProcesses > 0) {
		args.push('--pids-limit', String(options.maxProcesses))
	}
	if (config.cpuLimit !== undefined) {
		args.push('--cpus', String(config.cpuLimit))
	}

	for (const [key, value] of Object.entries(options.env ?? {})) {
		args.push('--env', `${key}=${value}`)
	}

	// The worker's credential, rendered VALUELESS and last among the `--env`
	// flags.
	//
	// Valueless, because `docker run --env NAME` reads the value out of the
	// docker CLI's own environment — which `runOnce` is handed — and an argv
	// is the wrong place for a secret: `ps` shows it to every user on the
	// host for as long as the CLI lives, and a non-zero run puts the whole
	// argv into the error this backend throws. The CLI environment is
	// readable only by the same user and root, and the message is redacted
	// besides.
	//
	// Last, because docker applies repeated `--env` flags in order and the
	// last one wins: a host that separately sets `NAMZU_SANDBOX_TOKEN` in
	// `options.env` — a copied example, an inherited environment — must not
	// be able to displace the value its own client is sending, which would
	// produce a container that rejects every call and reads as a broken
	// worker rather than as a duplicated setting.
	args.push('--env', 'NAMZU_SANDBOX_TOKEN')

	args.push(config.image)
	return args
}

async function spawnDockerSandbox(
	config: DockerBackendInternalConfig,
	options: SandboxBackendOptions,
	readiness: { readonly timeoutMs: number; readonly pollIntervalMs: number },
): Promise<Sandbox> {
	options.signal?.throwIfAborted()
	const resolvedLayout = config.layout
	const id = generateSandboxId()
	const docker = config.dockerBinary ?? DEFAULT_DOCKER_BINARY

	// The worker's per-instance credential, minted HERE — per `create()`, not
	// per process and never per image. Three properties are the point, and
	// each one rules out a cheaper shape:
	//
	//  - Per instance. A token baked into the image is shared by every
	//    container ever built from it and readable by anything that can pull
	//    it, which is a worse artifact than a documented absence: it looks
	//    like a credential while separating nobody.
	//  - Not in an argv, and not in any message. It rides in the docker CLI
	//    child's environment, which `runOnce` is handed, and the CLI resolves
	//    it there for the valueless `--env NAMZU_SANDBOX_TOKEN`; a non-zero
	//    `docker run` renders its argv with every `--env` value redacted. So
	//    `ps` on the host does not show it and the error this backend throws
	//    does not carry it — neither of which was true when the value was
	//    rendered into the argv.
	//  - Where it IS visible, said plainly: the container's own config, so
	//    `docker inspect <name>` shows it for the container's life, to anyone
	//    who can already talk to the daemon — the same authority that can
	//    `docker exec` into the sandbox. And the worker's own `/proc` inside
	//    the container, to a workload that shares its uid. Both are why it is
	//    per-instance and dies with the container rather than being shared or
	//    long-lived.
	//  - Dead with the container. Nothing revokes it, because the only process
	//    that would accept it is removed with the sandbox, and the container's
	//    config that still holds it is removed with it.
	//
	// 32 bytes rather than a uuid: this is a secret, not an identifier, and
	// base64url keeps it one argv-free environment value on every platform.
	const workerToken = randomBytes(32).toString('base64url')

	const hostReachability = config.hostReachability ?? 'host-port'
	// Whether a proxy CONTAINER will run, which is what `resolveNetwork` turns
	// on: an allowlist policy needs the image to run one as, and without it
	// there is no boundary to hand traffic to. The refusal lives in
	// `resolveNetwork` so that every caller of it gets the same answer, and it
	// fires before anything is started.
	const proxyPlanned = needsEgressProxy(options.egress) && config.egressProxyImage !== undefined
	const network = resolveNetwork(config.network ?? 'none', options.egress, proxyPlanned)
	// Whether this network can carry the reachability mode and the policy is
	// a fact about the network, so it is checked against the daemon rather
	// than inferred from its name. Before anything starts on purpose: a
	// refusal here is a wiring mistake and must not arrive dressed as a
	// container that failed to come up, which is exactly how it used to
	// arrive.
	assertNetworkCarriesThePolicy(
		network,
		hostReachability,
		options.egress,
		await inspectNetworkInternalFlag(docker, network, options.signal),
	)
	const containerName = `namzu-sandbox-${id}`

	/** The proxy container's name, once it is being started. */
	let egressProxyContainer: string | undefined
	/**
	 * The allowlist the running proxy container was started with, or
	 * `undefined` when that is not known. See `setNetworkPolicy`.
	 */
	let appliedHosts: readonly string[] | undefined

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
		// The proxy container starts BEFORE the sandbox and its only other
		// teardown is in `destroy()`, which a create that never returned can
		// never reach. So every failure between the two — a daemon that is
		// down, a port that could not be read, a worker that missed its
		// readiness deadline, an abort — would leave a container holding real
		// credentials and a live route to the internet, and a retry loop left
		// one per attempt. That is the invariant this file states where the
		// proxy is started: it must not outlive the thing it was filtering
		// for. Start both arms before awaiting either: a stuck runtime must
		// not keep the credential-bearing one alive.
		//
		// The proxy arm is the reconciler rather than a `runOnceQuiet` on this
		// signal, and the difference is the grace this function's caller runs
		// under: `runFailureCleanup` spends ONE SECOND on both arms together,
		// so a daemon that is slow to answer rather than down would have its
		// `docker rm -f` killed at that boundary — the credential-bearing
		// container outliving the sandbox by exactly the failure this exists to
		// prevent. The reconciler carries its own deadline, is not reachable by
		// any abort, and is not waited on by the caller's grace either: it
		// finishes whether or not this function is still listening.
		const removeProxy =
			egressProxyContainer === undefined
				? Promise.resolve()
				: removeEgressProxyContainer(docker, egressProxyContainer)
		egressProxyContainer = undefined
		await Promise.all([removeContainer, removeProxy])
	}

	let hostPort: number
	let baseUrl: string
	// `outputs` is required by validation, so its containerPath is
	// always available — the worker uses it as its workspace root.
	const rootDir = resolvedLayout.outputs.containerPath

	try {
		// The boundary a host allowlist is actually enforced at, as a sibling
		// container on this container's network (#398). Started before the
		// sandbox so its alias is in the network's DNS by the time the sandbox's
		// proxy environment resolves it, and removed with the sandbox — a proxy
		// holding real credentials must not outlive the thing it was filtering
		// for, and on this topology a leftover one is also a live route to the
		// internet for anything that can reach that network.
		//
		// Inside this `try` on purpose, which the first cut of this change got
		// wrong. This block has three suspension points — the resolver, the
		// proxy's `docker run`, and an explicit `throwIfAborted()` — and an
		// abort at any of them leaves a container holding real credentials with
		// nothing that will ever remove it: `destroy()` is unreachable, because
		// `create()` never returned a handle. Outside the `try` the abort
		// rethrew past `cleanupOnFailure`; inside it, every path that does not
		// return a `Sandbox` goes through that cleanup, which removes the proxy
		// by name on a deadline of its own. The abort that arrives here has to
		// be raised by a call inside the block — the sandbox's own `docker run`
		// does that itself — so an abort before this point reaches the same
		// place by the same route.
		if (proxyPlanned && options.egress) {
			// Before anything is started, and only when there are port rules:
			// an image that cannot read them is refused by name here, rather
			// than started and left to exit after the readiness check passed.
			if (usesPortRules(config)) {
				await assertEgressProxyImageReadsPortRules(
					docker,
					config.egressProxyImage as string,
					options.signal,
				)
			}
			egressProxyContainer = egressProxyContainerName(id)
			// Resolved once, here, rather than per request — see
			// `egressProxyContainerConfig` for what that costs and why it is paid.
			const allowedHosts = await resolveAllowedHosts(options.egress)
			options.signal?.throwIfAborted()
			await startEgressProxyContainer({
				docker,
				config,
				containerName: egressProxyContainer,
				internalNetwork: network,
				allowedHosts,
				signal: options.signal,
			})
			appliedHosts = Object.freeze([...allowedHosts])
			options.signal?.throwIfAborted()
		}

		const args = buildDockerRunArgs({
			config,
			options,
			containerName,
			network,
			hostReachability,
			...(egressProxyContainer ? { egressProxyPort: EGRESS_PROXY_PORT_INSIDE_CONTAINER } : {}),
		})

		await runOnce(docker, args, options.signal, { NAMZU_SANDBOX_TOKEN: workerToken })
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

	type Lifecycle = 'active' | 'retiring' | 'destroyed'
	let activeExecutions = 0
	let lifecycle: Lifecycle = 'active'
	let retirementPromise: Promise<{ readonly accepted: boolean; readonly error?: Error }> | undefined
	let teardownPromise: Promise<void> | undefined
	let teardownComplete = false
	const workerClient = new HttpWorkerClient(baseUrl, workerToken)
	/**
	 * The tail of this sandbox's `setNetworkPolicy` calls. Each call chains
	 * onto it, so at most one swap is in flight. See `setNetworkPolicy`.
	 */
	let policyQueue: Promise<void> = Promise.resolve()
	const assertActive = (): void => {
		if (lifecycle !== 'active') {
			throw new Error(`Sandbox ${id} is ${lifecycle}; no new worker operation can be admitted`)
		}
	}
	const teardownSandbox = (signal?: AbortSignal): Promise<void> => {
		lifecycle = 'retiring'
		if (teardownComplete) return Promise.resolve()
		if (teardownPromise) return teardownPromise
		const attempt = (async () => {
			let teardownError: unknown
			try {
				await runOnce(docker, ['rm', '-f', containerName], signal)
			} catch (error) {
				teardownError = error
			} finally {
				// The proxy goes with the sandbox, for the reason it is
				// started before it: a container holding real credentials must
				// not outlive the thing it was filtering for, and on this
				// topology leaving it running would also leave a live route to
				// the internet on a network the sandbox was confined to.
				if (egressProxyContainer !== undefined) {
					try {
						await runOnce(docker, ['rm', '-f', egressProxyContainer], signal)
					} catch (error) {
						teardownError ??= error
					}
				}
			}
			if (teardownError !== undefined) throw teardownError
		})()
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
		const deadline = new OperationDeadline(5_000, `docker sandbox ${id} retirement`)
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

		async setNetworkPolicy(policy): Promise<void> {
			assertActive()
			// Enforceable only through the egress proxy. Without one the
			// container's network was fixed at creation — `--network none`
			// or not — and there is nothing to narrow: accepting the policy
			// here and doing nothing would leave the caller believing the
			// sandbox had been confined when it had not. Same rule the
			// egress-kind refusal above follows.
			if (egressProxyContainer === undefined) {
				throw withHint(
					new Error(
						'This sandbox cannot change its network policy: it was created without an egress proxy, so its network was fixed at creation and there is nothing to narrow. Refusing rather than accepting a policy that would not be applied.',
					),
					'Construct the provider with an egress proxy (and an egressProxyImage to run it as) to make the policy mutable, or create a second sandbox under the narrower policy.',
				)
			}
			// The policy lives in the proxy container's environment, which is
			// written when the container starts and cannot be rewritten from
			// outside. So a live policy change REPLACES the container: the
			// allowlist the caller asked for is the allowlist the next
			// connection meets, and the connections open at that instant fail
			// closed. That is a real difference from the in-process proxy this
			// used to be — it swapped the allowlist in place, with no window in
			// which the proxy was absent — and it is the honest trade for a
			// boundary the sandbox cannot route around. See
			// `docs/sdk/sandbox-egress.md`.
			//
			// The name is read out of the closure once, here, rather than at
			// each use below: `cleanupOnFailure` clears it, and a swap that
			// raced a failing create would otherwise call `assertActive()` and
			// then name `undefined` in the removal.
			const proxyContainer = egressProxyContainer
			// Copied now, so a caller that mutates its array while the call waits
			// its turn does not change what the call applies.
			const requested: readonly string[] = Object.freeze([...policy.allowedHosts])
			// Under a profile, a live change narrows within it and never widens
			// past it: the profile is what the host declared this sandbox may
			// reach, and a call that names more is refused before it is queued.
			const profile = config.egressProfile
			if (profile !== undefined) {
				requested.forEach((entry, index) => {
					if (egressProfileCoversEntry(profile, entry)) return
					throw new SandboxEgressProfileError(
						'invalid-host',
						`allowedHosts[${index}]`,
						`${JSON.stringify(entry)} is outside egress profile ${JSON.stringify(profile.name)}; setNetworkPolicy may narrow within the profile, not widen past it`,
						config.runtime === 'runsc' ? 'runsc' : 'docker',
					)
				})
			}
			// Calls are SERIALIZED per sandbox, first in first out, and each one
			// applies and verifies its OWN policy. Overlapping swaps used to
			// interleave remove, run, attach and inspect against one container
			// name: one call's pre-start removal, or a failure path's removal by
			// name, could land on the other call's container after that call had
			// resolved, leaving no proxy at all; and one call's readiness inspect
			// could read the other's container as running and resolve claiming a
			// policy that was not in force. There is no coalescing ("last writer
			// wins") on purpose: a call replaced by a later one would then resolve
			// while a different policy was in force, which is the same misreport.
			// The kubernetes backend's per-sandbox setter follows the same rule
			// (`per-sandbox-policy.ts`).
			const step = policyQueue.then(async () => {
				// Again, because a teardown may have landed while this call waited
				// behind another.
				assertActive()
				// A repeat of the policy the running container already enforces is a
				// no-op. This backend has no adopt path, so the sandbox handle is the
				// only owner of its proxy and this record is authoritative. It is
				// cleared before every swap and set again only when the swap
				// succeeds, because after a failure the state is unknown and the next
				// call must swap.
				if (appliedHosts !== undefined && sameHostList(appliedHosts, requested)) return
				appliedHosts = undefined
				try {
					await restartEgressProxyContainer({
						docker,
						config,
						containerName: proxyContainer,
						internalNetwork: network,
						allowedHosts: requested,
					})
					// A teardown that landed while the replacement was starting
					// leaves a container nothing else will ever remove: `destroy()`
					// is running or has run, `egressProxyContainer` is only removed
					// from `teardownSandbox` and `cleanupOnFailure`, and the
					// `assertActive()` above ran BEFORE the first `await` — before
					// the swap suspended inside `restartEgressProxyContainer`, which
					// is exactly when a teardown lands. So the swap fails here
					// rather than reporting a policy change on a sandbox that no
					// longer exists.
					assertActive()
				} finally {
					// ... and the replacement is removed even so, because the check
					// above cannot be where the guarantee lives. It sits AFTER the
					// container comes into existence, and that ordering is what
					// makes it airtight rather than merely narrower than the check
					// at entry. A generation counter read before the `docker run`
					// has the opposite shape: it can only refuse a start it already
					// knows about, and a teardown that begins between that refusal
					// being evaluated and the daemon committing the container is in
					// no check's view — the container exists and nothing has looked
					// since. Here the two orderings partition the space instead. A
					// teardown that began before this point has already set
					// `lifecycle`, synchronously (`teardownSandbox` and `retire()`
					// both do, before their first `await`), so this removal runs. A
					// teardown that begins after it issues its own `rm -f` for this
					// same name — `teardownSandbox` reads `egressProxyContainer`,
					// which is this container — against a container that, at this
					// point, exists. Whichever of the two runs second finds the
					// container and removes it, and both are idempotent.
					//
					// A signal-less remover, and not `runOnce` on some signal, for
					// the reason `removeEgressProxyContainer` exists: the teardown
					// this is racing may be one whose own signal was already
					// aborted, and it removes nothing at all in that case (the whole
					// container set is left, which is what `Sandbox.destroy`
					// promises to settle promptly over). That is the caller's
					// contract and not something to defeat — but a proxy container
					// holding brokered credentials and a live route to the internet
					// is not something to leave with it either.
					if (lifecycle !== 'active') {
						await removeEgressProxyContainer(docker, proxyContainer)
					}
				}
				appliedHosts = requested
			})
			// The chain continues past a rejection: one caller's failed swap is
			// that caller's error, not a reason to refuse every later call.
			policyQueue = step.then(
				() => undefined,
				() => undefined,
			)
			await step
		},

		async writeFile(path: string, content: string | Buffer): Promise<void> {
			assertActive()
			const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
			let res: Response
			try {
				res = await fetch(`${baseUrl}/write-file`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...workerAuthorization(workerToken),
					},
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
			if (res.status === 401) {
				throw withHint(
					new Error(`write-file failed: HTTP 401 ${await res.text()}`),
					WORKER_UNAUTHORIZED_HINT,
				)
			}
			if (!res.ok) {
				throw new Error(`write-file failed: HTTP ${res.status} ${await res.text()}`)
			}
		},

		/**
		 * The worker's `/read-file` has no range, so a caller asking for one
		 * is REFUSED rather than handed the whole file.
		 *
		 * {@link Sandbox.readFile} draws that line: a backend that takes
		 * `offset`/`length` and answers with everything has given a wrong
		 * answer, not a degraded one, and the caller stops looking. Declaring
		 * the one-parameter form would not close it — through the `Sandbox`
		 * type a caller can still pass options — so the refusal is explicit.
		 *
		 * `options.signal` IS honoured: the contract says it aborts the read,
		 * and one HTTP request is the whole read here, so it is handed to
		 * `fetch`.
		 */
		async readFile(path: string, options?: SandboxReadFileOptions): Promise<Buffer> {
			assertActive()
			if (options?.offset !== undefined || options?.length !== undefined) {
				throw new Error(
					'readFile: the docker worker serves whole files only, so offset/length cannot be honoured. Read the file whole, or use a backend that streams.',
				)
			}
			const res = await fetch(`${baseUrl}/read-file`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...workerAuthorization(workerToken),
				},
				body: JSON.stringify({ path, encoding: 'base64' }),
				signal: options?.signal,
			})
			if (res.status === 401) {
				throw withHint(
					new Error(`read-file failed: HTTP 401 ${await res.text()}`),
					WORKER_UNAUTHORIZED_HINT,
				)
			}
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

		async *walkFiles(
			rootPath: string,
			options: SandboxWalkFilesOptions,
		): AsyncIterable<SandboxFileEntry> {
			assertActive()
			activeExecutions += 1
			try {
				// Keep ownership through iterator.return(), including worker cancellation.
				yield* walkFilesViaExec(
					(command, argv, opts) => workerClient.exec(command, argv, opts),
					rootPath,
					options,
				)
			} catch (error) {
				if (error instanceof RemoteCancellationUnknownError) error.retirement = await retire()
				throw error
			} finally {
				activeExecutions = Math.max(0, activeExecutions - 1)
			}
		},

		async destroy(options?: SandboxDestroyOptions): Promise<void> {
			if (retirementPromise) {
				const observation = await retirementPromise
				if (observation.accepted) return
				retirementPromise = undefined
			}
			await teardownSandbox(options?.signal)
			// Backend never allocates host paths — every bind source
			// comes from the consumer-supplied layout. Container
			// teardown is sufficient; the consumer's own lifecycle
			// owns each `hostPath`.
		},
	}
}

/** The proxy's upstream network when the host named none. See the field. */
const DEFAULT_EGRESS_PROXY_UPSTREAM_NETWORK = 'bridge'

/**
 * How long a reconciliation remove of the proxy container may take.
 *
 * The same order as `retire()`'s own deadline, and for the same reason: this
 * bounds a call to a daemon that may never answer. It is a deadline of its own
 * rather than the caller's, because the caller is usually an aborted operation
 * — see {@link removeEgressProxyContainer}.
 */
const EGRESS_PROXY_REMOVE_TIMEOUT_MS = 5_000

/**
 * Remove the proxy container, on a path that is already failing.
 *
 * Three properties, each of which the first cut of this change got wrong, and
 * each of which is why this is a function rather than a `runOnceQuiet` call at
 * three sites:
 *
 *  - **It never takes the caller's signal.** A reconciliation remove handed an
 *    already-aborted signal does not reach the daemon at all: `runOnce` and
 *    `runOnceQuiet` install an abort listener that kills the child the moment
 *    they see one, so `docker rm -f` dies before it is spawned and the
 *    container survives — in exactly the case this exists to handle, an
 *    operation that was aborted midway through starting it.
 *  - **It is bounded anyway.** A fresh deadline of its own, so a daemon that
 *    never answers cannot hang the failure path that is cleaning up after it.
 *  - **It does not throw.** Whatever went wrong to bring the caller here is the
 *    thing the caller needs to hear; a failure to remove is reported by the
 *    container's own name in `docker ps` and by the label reaper this file
 *    documents, not by replacing that error with a worse one.
 */
async function removeEgressProxyContainer(docker: string, containerName: string): Promise<void> {
	const deadline = new OperationDeadline(
		EGRESS_PROXY_REMOVE_TIMEOUT_MS,
		`egress proxy container ${containerName} removal`,
	)
	try {
		await deadline.run((signal) => runOnceQuiet(docker, ['rm', '-f', containerName], signal))
	} catch {
		// Deliberately swallowed. See the third property above.
	}
}

interface EgressProxyContainerInput {
	readonly docker: string
	readonly config: DockerBackendInternalConfig
	readonly containerName: string
	readonly internalNetwork: string
	/**
	 * The hosts the proxy will permit, already resolved. Resolved by the
	 * caller rather than passed as a policy because the two callers resolve
	 * differently and the difference is the point: `create()` resolves a
	 * policy once through {@link resolveAllowedHosts}, and `setNetworkPolicy`
	 * is handed a list by definition (`SandboxNetworkPolicy`).
	 */
	readonly allowedHosts: readonly string[]
	readonly signal?: AbortSignal
}

/**
 * Start the proxy container: run it, join it to the internal network, prove it
 * is up.
 *
 * Three steps and not one, in this order, for reasons that are all about the
 * topology rather than about docker's ergonomics. `docker run --network
 * <upstream>` gives the proxy its default route — the leg that reaches the
 * internet. `docker network connect --alias` adds the internal leg the sandbox
 * dials it on, and it has to be second: a container created on an internal
 * network first comes up with no default route and never gets one, which is a
 * proxy that can reach nothing. The readiness check is third because the first
 * two are `docker run` exiting 0, and `docker run --detach` exits 0 for a
 * container whose entrypoint is about to fail — an image without the compiled
 * module in it, or a config the entrypoint refused. Those failures arrive as a
 * sandbox whose every outbound request fails, which reads as the policy
 * working.
 *
 * A failure after the container exists removes it before rethrowing. Leaving
 * it would leave a container holding real credentials and a live route to the
 * internet with no sandbox it belongs to. This is not the only remover on that
 * path: the block that starts this container sits INSIDE the `try` that owns
 * `cleanupOnFailure`, and the name it is started under is in
 * `egressProxyContainer` from before the call, so the caller's cleanup removes
 * the same name again. The first cut of this change had the block outside that
 * `try` and this sentence said the caller's own cleanup could not see the
 * container; the two were wrong together, and the leak was real.
 */
async function startEgressProxyContainer(input: EgressProxyContainerInput): Promise<void> {
	const { docker, config, containerName, internalNetwork, allowedHosts, signal } = input

	const argvInput: EgressProxyArgvInput = {
		config,
		containerName,
		upstreamNetwork: config.egressProxyUpstreamNetwork ?? DEFAULT_EGRESS_PROXY_UPSTREAM_NETWORK,
		internalNetwork,
	}
	// The policy, on its way to the container's environment by way of the
	// `docker` CLI's own. See `renderEgressProxyRunArgs` for why it does not
	// travel in the argv.
	const proxyEnvironment = {
		[egressProxyConfigEnvName(config)]: JSON.stringify(
			egressProxyContainerConfig(config, allowedHosts, EGRESS_PROXY_PORT_INSIDE_CONTAINER),
		),
	}

	try {
		await runOnce(docker, renderEgressProxyRunArgs(argvInput), signal, proxyEnvironment)
	} catch (error) {
		// The container may exist even though this call did not return
		// successfully: `docker run --detach` is a CLI process talking to a
		// daemon, and the daemon can commit the container while the client is
		// killed, times out, or fails to report the id back. Remove by name
		// before rethrowing, which is what the docblock above promised in the
		// first cut of this change and did not do.
		await removeEgressProxyContainer(docker, containerName)
		// An abort is not a failure to start, and the caller that aborted is
		// entitled to hear its own reason back — the same rule every other
		// catch in this file follows. Without this an acquisition timeout would
		// arrive dressed as an image-install problem, which is the diagnosis
		// shape this file refuses everywhere else.
		signal?.throwIfAborted()
		throw withHint(
			new Error(
				`Could not start the egress proxy container '${containerName}' from image '${config.egressProxyImage}': ${error instanceof Error ? error.message : String(error)}`,
			),
			'Build that image with `docker build -f packages/sandbox/egress-proxy/Dockerfile -t <tag> packages/sandbox` (after `pnpm --filter @namzu/sandbox build`), and name the tag in egressProxyImage. The sandbox is deliberately not started when the only way its traffic reaches the internet is missing.',
		)
	}

	try {
		await runOnce(docker, renderEgressProxyAttachArgs(argvInput), signal)
		await assertEgressProxyContainerIsRunning(docker, containerName, signal)
	} catch (error) {
		await removeEgressProxyContainer(docker, containerName)
		throw error
	}
}

/**
 * Replace the proxy container, for `setNetworkPolicy`.
 *
 * The policy the container enforces is in its environment, which is written
 * when it starts and is not writable from outside, so a live policy change is
 * a new container. The window between the two is one in which the sandbox has
 * no route out at all — the old proxy is gone and the new one is not up yet —
 * which fails CLOSED. That is the property worth naming: the alternative
 * ordering (start the second, then remove the first) has no such window, but
 * two containers cannot hold the same name or the same network alias, so it
 * would need a second name the sandbox's `HTTP_PROXY` does not know.
 */
async function restartEgressProxyContainer(
	input: Omit<EgressProxyContainerInput, 'signal'>,
): Promise<void> {
	await removeEgressProxyContainer(input.docker, input.containerName)
	try {
		await startEgressProxyContainer(input)
	} catch (error) {
		// The hint names both states rather than assuming the safe one. The
		// removal above swallows its own failure, so "the old container is
		// gone" is not something this function knows: if the daemon never
		// answered the remove, the previous container is still up and still
		// enforcing the policy the caller just replaced — which would be a
		// worse thing to misreport than a sandbox with no route out.
		throw withHint(
			error instanceof Error ? error : new Error(String(error)),
			"Check `docker ps` for this sandbox's proxy container before relying on the new policy: the replacement did not come up, so this sandbox either has no route out at all (every request fails closed) or still has the previous container enforcing the policy you just replaced. Retry, or destroy the sandbox and create it under the policy you want.",
		)
	}
}

/**
 * Whether the daemon says the proxy container is still up.
 *
 * Read the same way {@link inspectNetworkInternalFlag} reads the network's
 * `Internal` flag, and for the same reason: an unreadable answer is not
 * evidence. A container that has already exited is gone (`--rm` removed it),
 * so the failure arrives as a failed `docker inspect` rather than as a
 * `false`, and both have to land on the same refusal.
 */
async function assertEgressProxyContainerIsRunning(
	docker: string,
	containerName: string,
	signal?: AbortSignal,
): Promise<void> {
	let running = ''
	try {
		running = await runOnce(
			docker,
			['inspect', '--format', '{{.State.Running}}', containerName],
			signal,
		)
	} catch {
		signal?.throwIfAborted()
		running = ''
	}
	if (running.trim() === 'true') return
	throw withHint(
		new Error(
			`The egress proxy container '${containerName}' is not running after being started, so this sandbox has no boundary to reach and no other route out.`,
		),
		'Almost always the image: it either lacks the compiled module (build the package before the image — `pnpm --filter @namzu/sandbox build`) or the entrypoint refused its configuration. `docker logs <container>` has the line the entrypoint wrote; the container is started with --rm, so an already-exited one is gone and its output with it.',
	)
}

/**
 * Refuse an egress proxy image that does not declare it reads port rules.
 *
 * Reads {@link EGRESS_PROXY_IMAGE_CONFIG_LABEL} off the image with `docker
 * image inspect`, which needs the image to be present on the daemon: `docker
 * run` would pull a missing image, and this check does not, so an image that
 * has never been pulled is refused with that in the hint. Anything other than
 * `2` or higher, including an unreadable answer, is a refusal.
 */
async function assertEgressProxyImageReadsPortRules(
	docker: string,
	image: string,
	signal?: AbortSignal,
): Promise<void> {
	let label = ''
	try {
		label = await runOnce(
			docker,
			[
				'image',
				'inspect',
				'--format',
				`{{ index .Config.Labels "${EGRESS_PROXY_IMAGE_CONFIG_LABEL}" }}`,
				image,
			],
			signal,
		)
	} catch {
		signal?.throwIfAborted()
		label = ''
	}
	const version = Number(label.trim())
	if (Number.isInteger(version) && version >= 2) return
	throw withHint(
		new Error(
			`The egress proxy image '${image}' does not declare that it reads port rules (label ${EGRESS_PROXY_IMAGE_CONFIG_LABEL} is ${JSON.stringify(label.trim())}, and 2 is needed), and this sandbox's egress profile carries ports. Refusing rather than starting a proxy that would exit on a configuration it cannot read.`,
		),
		'Rebuild the image from packages/sandbox/egress-proxy/Dockerfile (`pnpm --filter @namzu/sandbox build`, then `docker build -f packages/sandbox/egress-proxy/Dockerfile -t <tag> packages/sandbox`), and pull it onto the daemon first if it lives in a registry. A profile without ports needs no rebuild.',
	)
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
			if (err instanceof RemoteProtocolError) throw err
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

/**
 * The argv as it may appear in an error message: the KEYS of every env
 * entry, with the values replaced.
 *
 * A rendered argv is the last place a secret should survive. A non-zero
 * `docker run` is a routine outcome — a missing image, a name conflict, a
 * daemon hiccup, ENOSPC — and its message goes wherever the sandbox
 * package's errors go: a log line, a telemetry batch, a CI transcript, a
 * pasted bug report. The env flags carry the worker's credential and every
 * value the host put in `options.env` (an API key, a broker token), and
 * none of them are needed to explain an exit code. The keys are kept
 * because they are what distinguishes "the image could not be pulled" from
 * "the environment was rejected".
 *
 * EVERY SPELLING docker accepts for that flag, not the one this backend
 * happens to emit today. `-e` IS `--env`, separated or `=`-attached, and
 * this function used to compare each element to the literal `'--env'`: the
 * long separated form this builder writes was redacted and `-e K=V`,
 * `--env=K=V` and `-e=K=V` were printed in full. A future caller writing
 * any of the three would have put a credential in a log line behind a
 * docblock that promised it would not. The covered forms are `--env K=V`,
 * `--env=K=V`, `-e K=V`, `-e=K=V` and the attached short form `-eK=V`; the
 * one shape it does not read is a value attached to an `-e` bundled into a
 * group of other short flags (`-iteK=V`), which no caller here writes and
 * which no rule short of matching `-e` anywhere inside an option could
 * catch. A valueless entry in any form (`--env K`) is passed through: it
 * resolves from the CLI's own environment and carries no value to redact.
 *
 * That redacts the workspace paths the layout is rendered from as well,
 * which are not secrets. They are also not what an exit code is about, and
 * a rule with exceptions is a rule that leaks the first time someone's
 * credential does not look like one.
 */
export function redactDockerArgv(args: readonly string[]): string[] {
	const rendered = [...args]
	/** `K=V` → `K=<redacted>`, keeping the key; a valueless entry is left alone. */
	const redactEntry = (entry: string): string => {
		const separator = entry.indexOf('=')
		return separator > 0 ? `${entry.slice(0, separator)}=<redacted>` : entry
	}
	for (let index = 0; index < rendered.length; index += 1) {
		const arg = rendered[index] as string
		if (arg === '--env' || arg === '-e') {
			const entry = rendered[index + 1]
			if (entry !== undefined) rendered[index + 1] = redactEntry(entry)
			index += 1
			continue
		}
		// Attached, where the option's value is the rest of the same element:
		// the `=` forms, and the short form with no separator (`-eK=V`).
		const prefix = arg.startsWith('--env=')
			? '--env='
			: arg.startsWith('-e=')
				? '-e='
				: arg.startsWith('-e') && arg.length > 2
					? '-e'
					: undefined
		if (prefix !== undefined) rendered[index] = prefix + redactEntry(arg.slice(prefix.length))
	}
	return rendered
}

/**
 * Run a docker subcommand to completion.
 *
 * `extraEnv` is added to the child's environment rather than the parent's, and
 * it is how a value reaches a container without entering the argv this file
 * builds. Two callers use it, for the same reason:
 *
 *  - The sandbox's own `docker run`, which hands over the worker's
 *    per-instance credential for the valueless `--env NAMZU_SANDBOX_TOKEN` its
 *    argv carries (minted in `spawnDockerSandbox`).
 *  - The egress proxy's `docker run`, which names its configuration variable
 *    in the argv and hands the value over here. See
 *    `renderEgressProxyRunArgs`.
 *
 * Anything a process is told through the environment is visible to `ps`'s
 * neighbour, `/proc/<pid>/environ`, only to the user that owns it — while an
 * argv is world-readable on Linux.
 */
function runOnce(
	binary: string,
	args: string[],
	signal?: AbortSignal,
	extraEnv?: Readonly<Record<string, string>>,
): Promise<string> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted()
		const child = spawn(binary, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			// The one channel a value can ride in without entering the argv
			// this process builds: `ps` shows an argv to every user on the
			// host, and `/proc/<pid>/environ` is readable only by the same
			// user and root. `docker run --env NAME` (no `=`) reads the value
			// out of the CLI's own environment, which is why the credential
			// is passed this way and rendered valueless in the argv.
			...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
		})
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
			else
				finish(
					new Error(
						`${binary} ${redactDockerArgv(args).join(' ')} exited ${code}: ${stderr.trim()}`,
					),
				)
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
