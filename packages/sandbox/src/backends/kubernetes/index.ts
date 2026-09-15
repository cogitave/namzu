/**
 * Kubernetes / agent-sandbox backend — acquire, readiness and teardown.
 *
 * Sibling of `firecracker/` and `aci-standby-pool/`: same
 * {@link SandboxBackend} surface, same "the host supplies the credential
 * callback and this package carries no cloud SDK" boundary, a different
 * control plane. Here the control plane is the Kubernetes API server and the
 * warm pool is a `SandboxWarmPool` reconciled by the agent-sandbox controller
 * (kubernetes-sigs/agent-sandbox v1.0.2).
 *
 * Registered as `microvm` because {@link SandboxTier} names the strength of
 * the boundary, not the orchestrator that starts it: a pod scheduled onto a
 * Kata RuntimeClass runs in a hardware-virtualized guest. The tier also keeps
 * the backend out of the container tier's mandatory
 * `ContainerSandboxLayout`, which a remote-copy backend has no use for —
 * Firecracker took the same exemption.
 *
 * ## Two acquire paths, and why they create different kinds
 *
 *  - `warmPoolName` set → POST a `SandboxClaim` at the named pool. The
 *    controller binds an already-running Sandbox out of the pool, which is
 *    what makes a sub-second acquire possible at all.
 *  - `warmPoolName` unset → POST a `Sandbox` directly. This is necessitated
 *    rather than chosen: `SandboxClaimSpec.warmPoolRef` is a REQUIRED field,
 *    so a pool-less claim does not exist in the API.
 *
 * The claim this backend POSTs is PRISTINE: `warmPoolRef` and a lifecycle
 * bound, nothing else. `spec.env` and `spec.volumeClaimTemplates` are
 * available on the claim and are never set, because a claim carrying either
 * is forced to cold-start instead of adopting a pool sandbox — the single
 * most expensive mistake available on this path, and a silent one, since such
 * a claim still works and only the latency shows it. Per-sandbox controls
 * that would need those fields are refused by {@link assertEnforceable}
 * rather than accepted and dropped.
 *
 * ## The bound sandbox is not named after the claim
 *
 * A pool sandbox keeps the generated name the pool gave it when the claim
 * adopts it. The backend therefore reads the bound identity back out of
 * `status.sandbox` and never derives it from the claim's own name. A test
 * covers exactly that asymmetry.
 *
 * ## Credential
 *
 * The per-instance agent bind token is the backing pod's own
 * `metadata.uid`: the host learns it from the API server after readiness, the
 * guest learns it through the downward API (`NAMZU_AGENT_BIND_TOKEN`), and
 * nothing has to be minted, stored or injected at claim time. One GET, no
 * claim mutation, so the warm path stays pristine. A resumed pod is a new pod
 * with a new uid, which is correct: it is a new instance.
 *
 * ## Not watch
 *
 * Readiness is polled against the shared {@link OperationDeadline}, exactly as
 * ACI polls `provisioningState`. A watch would buy nothing on a path whose
 * whole budget is under a second, and would cost resourceVersion tracking,
 * bookmarks, 410-relist and reconnect backoff.
 */

import type {
	Sandbox,
	SandboxDestroyOptions,
	SandboxEnvironment,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxFileEntry,
	SandboxId,
	SandboxStatus,
} from '@namzu/sdk'
import { generateSandboxId } from '@namzu/sdk'

import type { SandboxBackend, SandboxBackendOptions } from '../../index.js'
import {
	OperationDeadline,
	OperationDeadlineExpired,
	resolveReadinessOptions,
	runFailureCleanup,
} from '../readiness.js'
import {
	type KubernetesAccess,
	KubernetesAlreadyGoneError,
	type KubernetesClient,
	createKubernetesClient,
} from './k8s-client.js'
import {
	type PodListResource,
	type PodResource,
	READY_CONDITION,
	SANDBOX_API_GROUP,
	SANDBOX_API_VERSION,
	SANDBOX_EXTENSIONS_API_GROUP,
	type SandboxClaimResource,
	type SandboxPodTemplate,
	type SandboxResource,
	type SandboxTemplateResource,
	claimCollectionPath,
	claimPath,
	isConditionTrue,
	podListPath,
	podPath,
	sandboxCollectionPath,
	sandboxPath,
	sandboxTemplatePath,
} from './objects.js'

/**
 * How the backend reaches the API server. Two sources, neither needing a YAML
 * parser — see `k8s-client.ts` for the reasoning.
 */
export type KubernetesClusterAccess =
	| { readonly inCluster: true }
	| {
			readonly inCluster?: false
			readonly server: string
			readonly ca?: string | Buffer
			readonly getToken: () => Promise<string>
	  }

export interface KubernetesBackendInternalConfig {
	readonly access: KubernetesClusterAccess
	/** Namespace the claims, sandboxes and pods live in. */
	readonly namespace: string
	/**
	 * SandboxTemplate whose `podTemplate` a POOL-LESS create copies into the
	 * Sandbox it posts. The warm path never reads it — the pool's own
	 * `sandboxTemplateRef` decides there — but an operator reading this config
	 * still learns which template these sandboxes are built from.
	 */
	readonly sandboxTemplateName: string
	/** Named `SandboxWarmPool`. Absent → every create is a direct Sandbox. */
	readonly warmPoolName?: string
	/** TCP port the guest agent listens on. Default {@link DEFAULT_AGENT_PORT}. */
	readonly agentPort?: number
	readonly readyPollIntervalMs?: number
	readonly readyTimeoutMs?: number
	/** Lifetime bound written into every created object. Default 1 hour. */
	readonly claimTtlSeconds?: number
	/**
	 * RuntimeClass for a POOL-LESS create. Refused together with
	 * `warmPoolName`: a pooled sandbox's runtime class is fixed by the pool's
	 * SandboxTemplate and cannot be chosen per claim.
	 */
	readonly runtimeClassName?: string
}

/**
 * The address the guest agent answers on, plus the token to present.
 *
 * Structurally the `tcp` arm of the transport's `SandboxAgentHandle`. It is
 * declared here rather than imported so acquire does not depend on the
 * transport landing first; the two are asserted equal where they meet.
 */
export interface KubernetesAgentAddress {
	readonly kind: 'tcp'
	readonly host: string
	readonly port: number
	readonly token: string
}

/** What the controller bound, read back off the object's own status. */
export interface KubernetesSandboxBinding {
	/** The Sandbox's own name — NOT the claim's. */
	readonly name: string
	readonly podIPs?: readonly string[]
	readonly serviceFQDN?: string
	/** `Sandbox.status.selector`, when the path that read it had it for free. */
	readonly podSelector?: string
}

/** One acquired sandbox: what it is, where it answers, how to give it back. */
export interface KubernetesAcquisition {
	readonly binding: KubernetesSandboxBinding
	readonly agent: KubernetesAgentAddress
	/** API path of the object THIS backend created — the claim, or the Sandbox. */
	readonly ownedPath: string
	/** DELETE that object. An already-gone object counts as released. */
	release(signal?: AbortSignal): Promise<void>
}

/**
 * The same number the Firecracker guest agent listens on over vsock
 * (`DEFAULT_AGENT_VSOCK_PORT`), so one agent has one port across both tiers
 * and a manifest, a NetworkPolicy and a transport can all name it from
 * memory. Unprivileged, and the sandbox pod is not sharing it with anything.
 */
export const DEFAULT_AGENT_PORT = 1024

/**
 * Deliberately far below ACI's 500 ms. A pool bind lands in ~120 ms on a warm
 * cluster, so a half-second poll would spend most of the sub-second acquire
 * budget asleep; 50 ms costs a handful of cheap GETs and gives the measurement
 * somewhere to land.
 */
const DEFAULT_READY_POLL_MS = 50
const DEFAULT_READY_TIMEOUT_MS = 60_000
const DEFAULT_CLAIM_TTL_SECONDS = 3_600

/**
 * Per-sandbox controls this backend cannot apply, and therefore refuses.
 *
 * `env` is the load-bearing one. A SandboxClaim CAN carry `spec.env`, so this
 * looks at first like a control that fits — but a claim that sets it is forced
 * to cold-start instead of adopting a pool sandbox, which turns a 120 ms
 * acquire into a full pod start. Accepting env here would buy a caller a
 * feature and silently take the warm pool away, and the only symptom would be
 * latency. The limits belong on the SandboxTemplate the pool is built from.
 *
 * `egress` is refused because this backend applies egress at the network
 * layer, on the template's NetworkPolicy, which cannot be rewritten per
 * running sandbox. The container backend's habit of emitting proxy
 * environment variables as a substitute is not repeated here: a policy
 * accepted and quietly not enforced is worse than one that is refused.
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
		`The kubernetes sandbox backend cannot enforce per-sandbox ${unenforceable
			.map(([, label]) => label)
			.join(
				', ',
			)}: a SandboxClaim carrying env or volumes is forced to cold-start instead of adopting a warm pool sandbox, and egress is a NetworkPolicy on the pool's SandboxTemplate rather than a per-sandbox setting. Set them on the SandboxTemplate the SandboxWarmPool is built from, or use a backend that applies them per sandbox. Refusing rather than accepting a control that would be silently dropped.`,
	)
}

/**
 * Refuse a runtime class the pool path cannot honour.
 *
 * A pooled sandbox is already running by the time a claim reaches it, under
 * whatever RuntimeClass its SandboxTemplate named. `runtimeClassName` in this
 * config would therefore be read, accepted and ignored — and the thing it
 * selects is the VM boundary, which is the last control to lose quietly.
 */
export function assertRuntimeClassIsApplicable(config: {
	warmPoolName?: string
	runtimeClassName?: string
}): void {
	if (config.runtimeClassName === undefined || config.warmPoolName === undefined) return
	throw new Error(
		`The kubernetes sandbox backend cannot apply runtimeClassName ${JSON.stringify(config.runtimeClassName)} to sandboxes claimed from warm pool ${JSON.stringify(config.warmPoolName)}: a pooled sandbox is already running under the RuntimeClass its SandboxTemplate named, and a claim cannot change it. Set runtimeClassName on that SandboxTemplate's podTemplate, or drop warmPoolName to have this backend create each Sandbox itself.`,
	)
}

/**
 * Raised by the Sandbox methods that need the guest agent transport, which
 * lands with the sandbox surface in the next change. Acquire, address
 * resolution, readiness and teardown are real today; execution is not, and
 * says so rather than failing as a `TypeError` on an absent method.
 */
export class KubernetesAgentTransportPendingError extends Error {
	override readonly name = 'KubernetesAgentTransportPendingError'

	constructor(
		readonly operation: string,
		readonly sandboxName: string,
	) {
		super(
			`kubernetes sandbox ${sandboxName} is acquired and its agent address is resolved, but ${operation}() needs the guest agent transport, which this build of @namzu/sandbox does not wire yet. Acquire, readiness and teardown work; exec, file IO and terminals arrive with the sandbox surface.`,
		)
	}
}

/**
 * Build a {@link SandboxBackend} against a cluster running the agent-sandbox
 * controller. Construction is synchronous and contacts nothing: readiness
 * bounds and the config refusals are validated here so a misconfiguration
 * surfaces during host wiring rather than mid-run, and the first API call
 * happens on the first `create()`.
 */
export function buildKubernetesBackend(config: KubernetesBackendInternalConfig): SandboxBackend {
	const readiness = resolveReadinessOptions(
		'kubernetes',
		config.readyTimeoutMs,
		config.readyPollIntervalMs,
		{ timeoutMs: DEFAULT_READY_TIMEOUT_MS, pollIntervalMs: DEFAULT_READY_POLL_MS },
	)
	assertRuntimeClassIsApplicable(config)
	const client = createKubernetesClient(clientAccess(config))
	return {
		tier: 'microvm',
		name: 'kubernetes',
		async create(options: SandboxBackendOptions): Promise<Sandbox> {
			const acquisition = await acquireKubernetesSandbox(client, config, options, readiness)
			return buildAcquiredSandbox(acquisition, options)
		},
	}
}

function clientAccess(config: KubernetesBackendInternalConfig): KubernetesAccess {
	const access = config.access
	if (access.inCluster === true) return { inCluster: true }
	return {
		server: access.server,
		namespace: config.namespace,
		getToken: access.getToken,
		...(access.ca !== undefined ? { ca: access.ca } : {}),
	}
}

/**
 * Claim or create, wait for Ready, read the bound identity back, resolve the
 * address and learn the pod's uid — or leave nothing behind trying.
 *
 * Exported because the sandbox surface is built on top of this record rather
 * than beside it: one acquire path, one cleanup path, whatever ends up
 * wrapping them.
 */
export async function acquireKubernetesSandbox(
	client: KubernetesClient,
	config: KubernetesBackendInternalConfig,
	options: SandboxBackendOptions,
	readiness: { readonly timeoutMs: number; readonly pollIntervalMs: number },
): Promise<KubernetesAcquisition> {
	options.signal?.throwIfAborted()
	assertEnforceable(options)
	assertRuntimeClassIsApplicable(config)

	const namespace = config.namespace
	const ttlSeconds = config.claimTtlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS
	const shutdownTime = new Date(Date.now() + ttlSeconds * 1_000).toISOString()
	// Client-owned name, as on ACI: it lets failure cleanup DELETE the object
	// even when the create response never arrived. `generateSandboxId` returns
	// a lowercase UUID, which is already a legal DNS-1123 name suffix.
	const objectName = `namzu-task-${generateSandboxId()}`
	const ownedPath =
		config.warmPoolName !== undefined
			? claimPath(namespace, objectName)
			: sandboxPath(namespace, objectName)

	const release = async (signal?: AbortSignal): Promise<void> => {
		try {
			await client.request('DELETE', ownedPath, undefined, signal)
		} catch (err) {
			// The object is gone, which is the state DELETE was asking for.
			if (!(err instanceof KubernetesAlreadyGoneError)) throw err
		}
	}

	// One clock over the whole path — the create POST included, so a hung API
	// server cannot leave `create()` pending past the caller's timeout.
	const deadline = new OperationDeadline(
		readiness.timeoutMs,
		'kubernetes readiness',
		options.signal,
	)

	// The pool-less path reads its pod template BEFORE anything is created, so
	// a missing or malformed template fails with nothing to clean up — hence
	// this sits outside the cleanup block below. It is read per create rather
	// than cached: an operator editing the template expects the next sandbox to
	// use it, and this path is not the sub-second one.
	const createPath =
		config.warmPoolName !== undefined
			? claimCollectionPath(namespace)
			: sandboxCollectionPath(namespace)
	const createBody =
		config.warmPoolName !== undefined
			? buildClaimBody(namespace, objectName, config.warmPoolName, shutdownTime)
			: buildSandboxBody(
					namespace,
					objectName,
					await deadline.run((signal) => readPodTemplate(client, namespace, config, signal)),
					shutdownTime,
					config.runtimeClassName,
				)

	try {
		// Inside the cleanup block: a POST that fails client-side may still have
		// committed, so the only safe assumption is that the object exists.
		await deadline.run((signal) => client.request('POST', createPath, createBody, signal))
		const binding =
			config.warmPoolName !== undefined
				? await pollForBinding(
						async (signal) =>
							bindingFromClaim(
								await client.request<SandboxClaimResource>(
									'GET',
									claimPath(namespace, objectName),
									undefined,
									signal,
								),
								objectName,
							),
						deadline,
						readiness,
						`claim ${objectName}`,
					)
				: await pollForBinding(
						async (signal) =>
							bindingFromSandbox(
								await client.request<SandboxResource>(
									'GET',
									sandboxPath(namespace, objectName),
									undefined,
									signal,
								),
							),
						deadline,
						readiness,
						`sandbox ${objectName}`,
					)

		const token = await deadline.run((signal) =>
			readPodBindToken(client, namespace, binding, signal),
		)
		return {
			binding,
			agent: resolveAgentAddress(binding, config.agentPort ?? DEFAULT_AGENT_PORT, token),
			ownedPath,
			release,
		}
	} catch (err) {
		// One cleanup for every way out of the block above, on its own short
		// budget: the readiness clock has already expired in the common case,
		// so spending it again would either skip cleanup or leave `create()`
		// pending without a bound. An object that is already gone is success.
		await runFailureCleanup(async (signal) => {
			await release(signal)
		})
		throw err
	}
}

/**
 * The claim body, in full. Everything absent from it is absent on purpose:
 * no `env`, no `volumeClaimTemplates`, no `additionalPodMetadata`. Either of
 * the first two forces a cold start upstream and takes the warm pool away.
 *
 * `shutdownTime` + `shutdownPolicy: 'Delete'` is the leak guard: it bounds the
 * object by the wall clock whatever the host does, so a host that dies
 * mid-acquire costs the cluster one TTL rather than one leaked sandbox
 * forever. `ttlSecondsAfterFinished` deliberately does NOT appear — its timer
 * starts from the Finished condition, which a crashed host never reaches.
 */
function buildClaimBody(
	namespace: string,
	name: string,
	warmPoolName: string,
	shutdownTime: string,
): Record<string, unknown> {
	return {
		apiVersion: `${SANDBOX_EXTENSIONS_API_GROUP}/${SANDBOX_API_VERSION}`,
		kind: 'SandboxClaim',
		metadata: { name, namespace },
		spec: {
			warmPoolRef: { name: warmPoolName },
			lifecycle: { shutdownTime, shutdownPolicy: 'Delete' },
		},
	}
}

/**
 * The pool-less body. `Sandbox.spec` has no `templateRef` — only a
 * SandboxWarmPool consumes a SandboxTemplate — so the template's podTemplate
 * is copied in here by the client.
 *
 * `service: true` is forced rather than inherited: a Sandbox without a Service
 * has no `status.serviceFQDN`, and then the only address left is a pod IP that
 * changes on every resume.
 */
function buildSandboxBody(
	namespace: string,
	name: string,
	podTemplate: SandboxPodTemplate,
	shutdownTime: string,
	runtimeClassName: string | undefined,
): Record<string, unknown> {
	const spec =
		runtimeClassName !== undefined
			? { ...podTemplate.spec, runtimeClassName }
			: { ...podTemplate.spec }
	return {
		apiVersion: `${SANDBOX_API_GROUP}/${SANDBOX_API_VERSION}`,
		kind: 'Sandbox',
		metadata: { name, namespace },
		spec: {
			operatingMode: 'Running',
			service: true,
			shutdownTime,
			shutdownPolicy: 'Delete',
			podTemplate: { ...podTemplate, spec },
		},
	}
}

async function readPodTemplate(
	client: KubernetesClient,
	namespace: string,
	config: KubernetesBackendInternalConfig,
	signal?: AbortSignal,
): Promise<SandboxPodTemplate> {
	const template = await client.request<SandboxTemplateResource>(
		'GET',
		sandboxTemplatePath(namespace, config.sandboxTemplateName),
		undefined,
		signal,
	)
	const podTemplate = template?.spec?.podTemplate
	if (!podTemplate || typeof podTemplate.spec !== 'object' || podTemplate.spec === null) {
		throw new Error(
			`kubernetes: SandboxTemplate ${config.sandboxTemplateName} in namespace ${namespace} carries no spec.podTemplate.spec, so there is nothing to create a pool-less Sandbox from. Sandbox.spec has no templateRef — the podTemplate has to be copied in.`,
		)
	}
	return podTemplate
}

/**
 * Where the agent answers.
 *
 * Its own function, and the Service FQDN wins over a pod IP, because the
 * address outlives the pod: a suspended-then-resumed workspace comes back as a
 * new pod with a new IP behind the same name, and the transport re-resolves
 * the name on every dial. A literal IP baked into a long-lived handle is the
 * bug that would produce.
 */
export function resolveAgentAddress(
	binding: KubernetesSandboxBinding,
	agentPort: number,
	token: string,
): KubernetesAgentAddress {
	const host = binding.serviceFQDN ?? binding.podIPs?.[0]
	if (host === undefined || host === '') {
		throw new Error(
			`kubernetes: sandbox ${binding.name} reported Ready with neither a serviceFQDN nor a pod IP, so its agent has no address to dial. Set 'service: true' on the SandboxTemplate the pool is built from.`,
		)
	}
	return { kind: 'tcp', host, port: agentPort, token }
}

function bindingFromClaim(
	claim: SandboxClaimResource | undefined,
	claimName: string,
): KubernetesSandboxBinding | undefined {
	if (!isConditionTrue(claim?.status?.conditions, READY_CONDITION)) return undefined
	const bound = claim?.status?.sandbox
	// Ready with no bound name is the controller contradicting itself; polling
	// on would just burn the deadline waiting for a field that is finished.
	if (!bound?.name) {
		throw new Error(
			`kubernetes: SandboxClaim ${claimName} reported Ready but named no sandbox in status.sandbox.name, so there is nothing to address.`,
		)
	}
	return {
		name: bound.name,
		...(bound.podIPs !== undefined ? { podIPs: bound.podIPs } : {}),
		...(bound.serviceFQDN !== undefined ? { serviceFQDN: bound.serviceFQDN } : {}),
	}
}

function bindingFromSandbox(
	sandbox: SandboxResource | undefined,
): KubernetesSandboxBinding | undefined {
	if (!isConditionTrue(sandbox?.status?.conditions, READY_CONDITION)) return undefined
	const name = sandbox?.metadata?.name
	if (!name) {
		throw new Error('kubernetes: Sandbox reported Ready with no metadata.name')
	}
	const status = sandbox?.status
	return {
		name,
		...(status?.podIPs !== undefined ? { podIPs: status.podIPs } : {}),
		...(status?.serviceFQDN !== undefined ? { serviceFQDN: status.serviceFQDN } : {}),
		...(status?.selector !== undefined ? { podSelector: status.selector } : {}),
	}
}

/**
 * Poll until `read` reports a binding. `read` returns `undefined` for "not
 * yet" and throws for a failure worth surfacing; the deadline owns every wait,
 * including the sleep between attempts, so an expired clock cannot be extended
 * by one more round trip. Shaped after ACI's `pollForRunningIp`.
 */
async function pollForBinding(
	read: (signal: AbortSignal) => Promise<KubernetesSandboxBinding | undefined>,
	deadline: OperationDeadline,
	readiness: { readonly timeoutMs: number; readonly pollIntervalMs: number },
	label: string,
): Promise<KubernetesSandboxBinding> {
	while (deadline.remainingMs() > 0) {
		try {
			const binding = await deadline.run(read)
			if (binding) return binding
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			throw err
		}
		try {
			await deadline.delay(readiness.pollIntervalMs)
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			throw err
		}
	}
	throw new Error(`kubernetes: ${label} never became Ready (${readiness.timeoutMs}ms)`)
}

/**
 * The per-instance bind token: the backing pod's `metadata.uid`.
 *
 * The pod is named after its Sandbox in agent-sandbox v1.0.2 — verified
 * against a running cluster — but that is an observation, not a documented
 * guarantee, and `Sandbox.status` exposes no pod name to fall back on. So the
 * fast path is one GET by that name, and the only cost of the name convention
 * changing upstream is a second round trip through `status.selector`, which is
 * exactly what the controller publishes the selector for.
 */
async function readPodBindToken(
	client: KubernetesClient,
	namespace: string,
	binding: KubernetesSandboxBinding,
	signal: AbortSignal,
): Promise<string> {
	try {
		const pod = await client.request<PodResource>(
			'GET',
			podPath(namespace, binding.name),
			undefined,
			signal,
		)
		const uid = pod?.metadata?.uid
		if (uid) return uid
	} catch (err) {
		if (!(err instanceof KubernetesAlreadyGoneError)) throw err
	}

	const selector =
		binding.podSelector ?? (await readSandboxSelector(client, namespace, binding, signal))
	if (selector !== undefined && selector !== '') {
		const list = await client.request<PodListResource>(
			'GET',
			podListPath(namespace, selector),
			undefined,
			signal,
		)
		for (const pod of list?.items ?? []) {
			const uid = pod.metadata?.uid
			if (uid) return uid
		}
	}
	throw new Error(
		`kubernetes: could not read a pod uid for sandbox ${binding.name} in namespace ${namespace} — no pod of that name, and its status.selector matched none either. The pod uid is the agent's bind token, so the sandbox is refused rather than returned unauthenticated.`,
	)
}

async function readSandboxSelector(
	client: KubernetesClient,
	namespace: string,
	binding: KubernetesSandboxBinding,
	signal: AbortSignal,
): Promise<string | undefined> {
	try {
		const sandbox = await client.request<SandboxResource>(
			'GET',
			sandboxPath(namespace, binding.name),
			undefined,
			signal,
		)
		return sandbox?.status?.selector
	} catch (err) {
		if (err instanceof KubernetesAlreadyGoneError) return undefined
		throw err
	}
}

function detectEnvironment(): SandboxEnvironment {
	// The guest runs Linux; the enum describes the host-facing shape of the
	// worker, not the isolation technology under it. Firecracker's guest
	// reports the same for the same reason.
	return 'linux-namespace'
}

/**
 * The Sandbox handed back by `create()` in THIS build: a real identity, a real
 * status and a real teardown, over an acquired and addressed pod.
 *
 * The four execution methods throw {@link KubernetesAgentTransportPendingError}
 * because the guest transport is a separate change. That is stated on the
 * docs page and in the changeset rather than left for a caller to discover:
 * the alternative shapes are a method that silently no-ops and a `TypeError`
 * from an absent one, and both teach the wrong thing.
 */
function buildAcquiredSandbox(
	acquisition: KubernetesAcquisition,
	options: SandboxBackendOptions,
): Sandbox {
	// The cluster owns this name. Preserving it verbatim as the sandbox id —
	// as the Firecracker backend preserves its orchestrator's — means a log
	// line carrying an id is also a `kubectl get sandbox` argument.
	const id = acquisition.binding.name as SandboxId
	let destroyed = false
	let teardownPromise: Promise<void> | undefined
	const pending = (operation: string): never => {
		throw new KubernetesAgentTransportPendingError(operation, acquisition.binding.name)
	}

	return {
		id,
		get status(): SandboxStatus {
			return destroyed ? 'destroyed' : 'ready'
		},
		rootDir: options.workingDirectory,
		environment: detectEnvironment(),

		async exec(
			_command: string,
			_args?: string[],
			_opts?: SandboxExecOptions,
		): Promise<SandboxExecResult> {
			return pending('exec')
		},

		async writeFile(_path: string, _content: string | Buffer): Promise<void> {
			return pending('writeFile')
		},

		async readFile(_path: string): Promise<Buffer> {
			return pending('readFile')
		},

		async listFiles(_rootPath: string): Promise<readonly SandboxFileEntry[]> {
			return pending('listFiles')
		},

		async destroy(destroyOptions?: SandboxDestroyOptions): Promise<void> {
			// Deleting the claim cascades to the sandbox it adopted through the
			// ownerReferences the controller re-parents on bind, so one DELETE
			// retires the pod, the Service and the object.
			if (teardownPromise) return await teardownPromise
			const attempt = acquisition.release(destroyOptions?.signal).then(
				() => {
					destroyed = true
				},
				(error: unknown) => {
					// A failed teardown must stay retryable; keeping the rejected
					// promise would answer every later destroy() with the same
					// stale failure.
					teardownPromise = undefined
					throw error
				},
			)
			teardownPromise = attempt
			await attempt
		},
	}
}
