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
 * ## The lease
 *
 * The `shutdownTime` acquire stamps is the leak guard AND, unrenewed, a
 * deadline on the run. The Sandbox handle owns a renewal loop that PATCHes
 * it forward every half-TTL for as long as the handle is alive, and
 * `destroy()` stops it — so a live run keeps its pod and a dead host still
 * costs the cluster exactly one expiry. See `lease.ts`.
 *
 * ## The privilege probe
 *
 * `create()` does not resolve until the guest has reported — and this
 * backend has checked — that it is deprivileged: all four capability masks
 * zero, `NoNewPrivs: 1`, read out of `/proc/self/status` over the agent's
 * `execute` op, on a clock of its own so a guest that goes quiet is refused
 * rather than waited on. A refusal destroys the instance and rejects, so no
 * handle to an under-hardened sandbox escapes. There is no off switch. See
 * `privilege-probe.ts`.
 *
 * ## Not watch
 *
 * Readiness is polled against the shared {@link OperationDeadline}, exactly as
 * ACI polls `provisioningState`. A watch would buy nothing on a path whose
 * whole budget is under a second, and would cost resourceVersion tracking,
 * bookmarks, 410-relist and reconnect backoff.
 *
 * ## Egress
 *
 * `config.egress` is optional and, when set, translated and VERIFIED — never
 * created — by `egress-policy.ts`. Verification happens once, lazily, on the
 * first `create()`, so `buildKubernetesBackend` itself still contacts
 * nothing. Every Sandbox this file creates directly (`buildSandboxBody`)
 * carries {@link sandboxTemplateLabel} on its podTemplate specifically so
 * that translated policy's `podSelector` has something stable to match —
 * see `objects.ts`'s doc comment on that label for why agent-sandbox's own
 * controller-owned label does not cover this path.
 */

import type { Sandbox } from '@namzu/sdk'
import { generateSandboxId } from '@namzu/sdk'

import type { SandboxBackend, SandboxBackendOptions } from '../../index.js'
import {
	OperationDeadline,
	OperationDeadlineExpired,
	resolveReadinessOptions,
	runFailureCleanup,
} from '../readiness.js'
import {
	type KubernetesEgressConfig,
	assertEgressPolicyIsEnforceable,
	defaultEgressPolicyName,
	translateEgressPolicy,
	verifyEgressPolicyApplied,
} from './egress-policy.js'
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
	type SandboxVolumeClaimTemplate,
	claimCollectionPath,
	claimPath,
	isConditionTrue,
	isPodLive,
	podListPath,
	podPath,
	sandboxCollectionPath,
	sandboxPath,
	sandboxTemplateLabel,
	sandboxTemplatePath,
} from './objects.js'
import { privilegeProbeTimedOut, runPrivilegeProbe } from './privilege-probe.js'
import { buildKubernetesSandbox } from './sandbox.js'
import { KubernetesAgentTransport } from './transport.js'

export type { KubernetesEgressConfig, KubernetesEgressEngine } from './egress-policy.js'

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
	/**
	 * Lifetime bound written into every created object, and the amount each
	 * lease renewal pushes the expiry forward. Default 1 hour.
	 */
	readonly claimTtlSeconds?: number
	/**
	 * Every lease-renewal failure that is not "the object is already gone".
	 * `@namzu/sandbox` owns no logger and reads none from module scope, so a
	 * diagnostic it cannot print is handed to the host that can. Renewal
	 * retries on the next tick either way; nothing here changes behaviour.
	 */
	readonly onLeaseRenewalError?: (error: unknown) => void
	/**
	 * RuntimeClass for a POOL-LESS create. Refused together with
	 * `warmPoolName`: a pooled sandbox's runtime class is fixed by the pool's
	 * SandboxTemplate and cannot be chosen per claim.
	 */
	readonly runtimeClassName?: string
	/**
	 * Egress policy this backend's `NetworkPolicy` (or `CiliumNetworkPolicy`,
	 * under `engine: 'cilium'`) is expected to carry. Unset means this backend
	 * neither computes nor verifies one — the cluster's default posture (the
	 * SandboxTemplate's own managed NetworkPolicy) is all that applies. See
	 * `egress-policy.ts`.
	 */
	readonly egress?: KubernetesEgressConfig
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
	/** The TTL acquire stamped, which every renewal re-stamps. */
	readonly ttlSeconds: number
	/** DELETE that object. An already-gone object counts as released. */
	release(signal?: AbortSignal): Promise<void>
	/**
	 * Merge-PATCH the created object's expiry forward to `shutdownTime`.
	 *
	 * On the acquisition rather than in `lease.ts` because only this path
	 * knows WHICH object it created and therefore where the field lives: a
	 * `SandboxClaim` carries it at `spec.lifecycle.shutdownTime`, a directly
	 * created `Sandbox` at `spec.shutdownTime` (v1beta1 as served keeps it at
	 * the top of `spec`). A merge patch of the nested object leaves
	 * `shutdownPolicy` alone.
	 */
	renew(shutdownTime: string, signal?: AbortSignal): Promise<void>
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
 * The ceiling on the privilege probe's own clock — see
 * {@link resolveProbeTimeoutMs} for where the rest of the number comes from.
 *
 * The probe is one `cat` of a pseudo-file over an already-established path,
 * so half a minute would already be generous and a quarter of one is plenty.
 * The number matters because the alternative is not "a bit longer": with no
 * clock of its own the probe falls back on the execution controller's generic
 * defaults — a five-minute execution observation, then a cancel-confirm and a
 * drain — so a guest that accepts the TCP connection and then stops answering
 * would keep a 60 s `create()` pending for over six minutes.
 */
const PRIVILEGE_PROBE_TIMEOUT_CAP_MS = 15_000

/**
 * How long the privilege probe may take, given the caller's readiness budget.
 *
 * `readyTimeoutMs` bounds the CONTROL plane and has usually expired by the
 * time the probe starts, so the probe cannot share it — but it is still the
 * number the caller chose to describe how long an acquire may take, so the
 * probe is allowed exactly that much again and no more, capped. A caller who
 * asked for a 500 ms acquire gets a 500 ms probe; one who asked for two
 * minutes of cold start still gets {@link PRIVILEGE_PROBE_TIMEOUT_CAP_MS}.
 * Deliberately not a separate config key: a knob whose only correct value is
 * "long enough for one `cat`" is a knob that only ever gets set wrong.
 */
export function resolveProbeTimeoutMs(readyTimeoutMs: number): number {
	return Math.min(readyTimeoutMs, PRIVILEGE_PROBE_TIMEOUT_CAP_MS)
}

/**
 * The readiness bounds every path in this backend polls against — acquire,
 * and `workspace.ts`'s create/suspend/resume. One function so the two cannot
 * drift apart on defaults.
 */
export function resolveKubernetesReadiness(config: {
	readonly readyTimeoutMs?: number
	readonly readyPollIntervalMs?: number
}): { readonly timeoutMs: number; readonly pollIntervalMs: number } {
	return resolveReadinessOptions('kubernetes', config.readyTimeoutMs, config.readyPollIntervalMs, {
		timeoutMs: DEFAULT_READY_TIMEOUT_MS,
		pollIntervalMs: DEFAULT_READY_POLL_MS,
	})
}

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
 * Build a {@link SandboxBackend} against a cluster running the agent-sandbox
 * controller. Construction is synchronous and contacts nothing: readiness
 * bounds and the config refusals are validated here so a misconfiguration
 * surfaces during host wiring rather than mid-run, and the first API call
 * happens on the first `create()`.
 */
export function buildKubernetesBackend(config: KubernetesBackendInternalConfig): SandboxBackend {
	const readiness = resolveKubernetesReadiness(config)
	assertRuntimeClassIsApplicable(config)
	// A hostname allowlist with no FQDN-capable engine declared is a
	// configuration error, not a runtime one — it can be decided from
	// `config.egress.policy.kind` alone, with no API call, so it is refused
	// here, synchronously, the same moment the two checks above are.
	if (config.egress) {
		assertEgressPolicyIsEnforceable(config.egress.policy, config.egress.engine ?? 'core')
	}
	const client = createKubernetesClient(clientAccess(config))
	// Verify-not-trust runs once, lazily, on the first `create()` — never here,
	// because `buildKubernetesBackend` is documented to contact nothing. A
	// failed attempt is not cached: a transient API error should not wedge
	// every later create() behind the same stale rejection forever.
	let egressVerification: Promise<void> | undefined
	return {
		tier: 'microvm',
		name: 'kubernetes',
		async create(options: SandboxBackendOptions): Promise<Sandbox> {
			if (config.egress) {
				egressVerification ??= verifyEgressPolicyConfigured(
					client,
					config.namespace,
					config.sandboxTemplateName,
					config.egress,
					options.signal,
				).catch((err: unknown) => {
					egressVerification = undefined
					throw err
				})
				await egressVerification
			}
			const acquisition = await acquireKubernetesSandbox(client, config, options, readiness)
			return await admitProbedSandbox(
				acquisition,
				config,
				options,
				resolveProbeTimeoutMs(readiness.timeoutMs),
			)
		},
	}
}

/**
 * Translate `egress.policy` and confirm an operator applied a matching
 * object — the whole verify-not-trust step, isolated so `create()` above
 * stays about ONE thing (memoize-once-per-backend) rather than two.
 *
 * Exported because `workspace.ts` runs the identical step: a workspace does
 * not go through `buildKubernetesBackend`, and a config `egress` honoured on
 * one entry point and ignored on the other would be a silent downgrade of the
 * boundary this backend calls primary. `sandboxTemplateName` is the template
 * the caller is actually building from — it decides both the default policy
 * name and the pod label the policy's selector has to match, and a workspace
 * may be built from a different template than the task path's.
 */
export async function verifyEgressPolicyConfigured(
	client: KubernetesClient,
	namespace: string,
	sandboxTemplateName: string,
	egress: KubernetesEgressConfig,
	signal?: AbortSignal,
): Promise<void> {
	const engine = egress.engine ?? 'core'
	const translated = await translateEgressPolicy(egress.policy, engine, {
		namespace,
		name: egress.networkPolicyName ?? defaultEgressPolicyName(sandboxTemplateName),
		sandboxTemplateName,
	})
	await verifyEgressPolicyApplied(client, translated, signal)
}

/** Config → the client's own access shape. Shared with `workspace.ts`. */
export function clientAccess(config: KubernetesBackendInternalConfig): KubernetesAccess {
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

	// Where the expiry lives differs by KIND, and only this function knows
	// which kind it created: a claim keeps it under `spec.lifecycle`, a
	// directly created Sandbox at the top of `spec` (v1beta1 as served has
	// not moved it under `lifecycle` yet). Merge-patch semantics (RFC 7386,
	// the only content type this client's PATCH sends) merge the nested
	// object, so `shutdownPolicy: Delete` survives every renewal.
	// The parameter is deliberately NOT named `shutdownTime`: the stamp above
	// is the one the create body carries, and no renewal ever re-sends it.
	const renew = async (nextShutdownTime: string, signal?: AbortSignal): Promise<void> => {
		const patch =
			config.warmPoolName !== undefined
				? { spec: { lifecycle: { shutdownTime: nextShutdownTime } } }
				: { spec: { shutdownTime: nextShutdownTime } }
		await client.request('PATCH', ownedPath, patch, signal)
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
			: buildSandboxBody({
					namespace,
					name: objectName,
					template: await deadline.run((signal) =>
						readSandboxTemplate(client, namespace, config.sandboxTemplateName, signal),
					),
					sandboxTemplateName: config.sandboxTemplateName,
					shutdownTime,
					...(config.runtimeClassName !== undefined
						? { runtimeClassName: config.runtimeClassName }
						: {}),
				})

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
			ttlSeconds,
			release,
			renew,
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
 * What a directly created Sandbox copies out of a `SandboxTemplate`, and the
 * two things it decides for itself.
 */
export interface SandboxBodyOptions {
	readonly namespace: string
	readonly name: string
	readonly template: SandboxTemplateCopy
	/** The template the copy came from — the value of {@link sandboxTemplateLabel}. */
	readonly sandboxTemplateName: string
	readonly runtimeClassName?: string
	/**
	 * RFC 3339 expiry, paired with `shutdownPolicy: Delete`. ABSENT means the
	 * object carries no expiry at all and nothing reaps it on the wall clock:
	 * that is the persistent workspace (`workspace.ts`), which is explicitly
	 * managed and must survive a host that stops renewing. Every task sandbox
	 * sets it, because an unbounded task sandbox is a leak.
	 */
	readonly shutdownTime?: string
}

/**
 * The pool-less body. `Sandbox.spec` has no `templateRef` — only a
 * SandboxWarmPool consumes a SandboxTemplate — so the template's podTemplate
 * is copied in here by the client.
 *
 * `service: true` is forced rather than inherited: a Sandbox without a Service
 * has no `status.serviceFQDN`, and then the only address left is a pod IP that
 * changes on every resume.
 *
 * `volumeClaimTemplates` is copied VERBATIM when the template declares any.
 * Dropping it would be silent: the Sandbox would come up healthy with no disk,
 * the container's `volumeDevices`/`volumeMounts` entry would fail to resolve
 * (or, worse, resolve to an empty emptyDir on some paths), and the only
 * symptom of a workspace that lost its disk would be that yesterday's files
 * are gone. The controller wires the mount by the entry's own NAME,
 * StatefulSet style, so the copy needs no matching `volumes:` entry and this
 * function adds none.
 *
 * The podTemplate's metadata gains {@link sandboxTemplateLabel}: this Sandbox
 * is created DIRECTLY, never adopted out of a pool, so it never gets
 * agent-sandbox's own controller-owned
 * `agents.x-k8s.io/sandbox-template-ref-hash` label (that is written only on
 * bind). Without a label of its own a direct Sandbox's pod would carry
 * nothing `egress-policy.ts`'s translated `NetworkPolicy` could select it
 * by. Existing labels on the copied template are preserved — this ADDS to
 * them rather than replacing the object outright — but this backend's own
 * key always wins if the template happened to set it too, since this is the
 * label the translated policy is built to match.
 */
export function buildSandboxBody(options: SandboxBodyOptions): Record<string, unknown> {
	const podTemplate = options.template.podTemplate
	const spec =
		options.runtimeClassName !== undefined
			? { ...podTemplate.spec, runtimeClassName: options.runtimeClassName }
			: { ...podTemplate.spec }
	const metadata = {
		...podTemplate.metadata,
		labels: {
			...podTemplate.metadata?.labels,
			...sandboxTemplateLabel(options.sandboxTemplateName),
		},
	}
	return {
		apiVersion: `${SANDBOX_API_GROUP}/${SANDBOX_API_VERSION}`,
		kind: 'Sandbox',
		metadata: { name: options.name, namespace: options.namespace },
		spec: {
			operatingMode: 'Running',
			service: true,
			...(options.shutdownTime !== undefined
				? { shutdownTime: options.shutdownTime, shutdownPolicy: 'Delete' }
				: {}),
			...(options.template.volumeClaimTemplates !== undefined
				? { volumeClaimTemplates: options.template.volumeClaimTemplates }
				: {}),
			podTemplate: { ...podTemplate, metadata, spec },
		},
	}
}

/** The two halves of a `SandboxTemplate` a directly created Sandbox copies. */
export interface SandboxTemplateCopy {
	readonly podTemplate: SandboxPodTemplate
	/** Absent when the template declares no disk, which is every task template. */
	readonly volumeClaimTemplates?: readonly SandboxVolumeClaimTemplate[]
}

export async function readSandboxTemplate(
	client: KubernetesClient,
	namespace: string,
	sandboxTemplateName: string,
	signal?: AbortSignal,
): Promise<SandboxTemplateCopy> {
	const template = await client.request<SandboxTemplateResource>(
		'GET',
		sandboxTemplatePath(namespace, sandboxTemplateName),
		undefined,
		signal,
	)
	const podTemplate = template?.spec?.podTemplate
	if (!podTemplate || typeof podTemplate.spec !== 'object' || podTemplate.spec === null) {
		throw new Error(
			`kubernetes: SandboxTemplate ${sandboxTemplateName} in namespace ${namespace} carries no spec.podTemplate.spec, so there is nothing to create a pool-less Sandbox from. Sandbox.spec has no templateRef — the podTemplate has to be copied in.`,
		)
	}
	const volumeClaimTemplates = template?.spec?.volumeClaimTemplates
	return {
		podTemplate,
		...(volumeClaimTemplates !== undefined ? { volumeClaimTemplates } : {}),
	}
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

/** Ready-or-not-yet, read off a `Sandbox`'s own status. Shared with `workspace.ts`. */
export function bindingFromSandbox(
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
export async function pollForBinding(
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
export async function readPodBindToken(
	client: KubernetesClient,
	namespace: string,
	binding: KubernetesSandboxBinding,
	signal?: AbortSignal,
): Promise<string> {
	try {
		const pod = await client.request<PodResource>(
			'GET',
			podPath(namespace, binding.name),
			undefined,
			signal,
		)
		const uid = pod?.metadata?.uid
		// `isPodLive` matters on the RESUME path in `workspace.ts`: a resumed
		// pod keeps its name, so for as long as the outgoing one is
		// terminating this GET can answer with the pod that is leaving and a
		// uid the new agent will refuse. On the acquire path nothing is
		// terminating and the filter never fires.
		if (uid && isPodLive(pod)) return uid
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
			if (uid && isPodLive(pod)) return uid
		}
	}
	throw new Error(
		`kubernetes: could not read a pod uid for sandbox ${binding.name} in namespace ${namespace} — no live pod of that name, and its status.selector matched no live pod either (a pod carrying a deletionTimestamp, or in phase Succeeded/Failed, is never bound to). The pod uid is the agent's bind token, so the sandbox is refused rather than returned unauthenticated.`,
	)
}

async function readSandboxSelector(
	client: KubernetesClient,
	namespace: string,
	binding: KubernetesSandboxBinding,
	signal?: AbortSignal,
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

/**
 * Build the Sandbox, prove it is deprivileged, and only then hand it back.
 *
 * The probe runs BEFORE `create()` resolves, so a caller never holds a
 * reference to an under-hardened sandbox — a probe that refuses destroys the
 * instance on a bounded cleanup budget and rethrows, exactly as a readiness
 * failure does. There is no configuration that skips it: the whole value of
 * checking the deprivileging on every acquire rather than once by hand is
 * that it cannot be forgotten, and an off switch is a way to forget it.
 *
 * The probe goes through the Sandbox's own `exec`, not the raw transport, so
 * it traverses the same reserve/admit/stream/confirm path every later call
 * will. A sandbox that cannot answer the probe is one a caller could not use
 * either.
 *
 * ## And it runs on a clock
 *
 * This is the first thing on the acquire path that talks to the GUEST, and
 * the readiness deadline that bounded everything before it has already
 * expired. Left unbounded the probe would inherit the execution controller's
 * generic defaults instead — a five-minute observation, then a cancel-confirm
 * and a drain — so a pod whose agent has wedged (out of memory, an event loop
 * the workload blocked) would keep `create()` pending for minutes past the
 * caller's `readyTimeoutMs` with nothing reported. It gets its own deadline,
 * whose expiry takes the same cleanup-and-reject path every other refusal
 * does, in words that name the hang rather than blame a missing `cat`.
 */
async function admitProbedSandbox(
	acquisition: KubernetesAcquisition,
	config: KubernetesBackendInternalConfig,
	options: SandboxBackendOptions,
	probeTimeoutMs: number,
): Promise<Sandbox> {
	const sandbox = buildKubernetesSandbox({
		name: acquisition.binding.name,
		rootDir: options.workingDirectory,
		transport: new KubernetesAgentTransport(acquisition.agent),
		release: acquisition.release,
		renew: acquisition.renew,
		ttlSeconds: acquisition.ttlSeconds,
		...(config.onLeaseRenewalError !== undefined
			? { onRenewalError: config.onLeaseRenewalError }
			: {}),
	})
	try {
		await probeSandboxPrivileges(sandbox, acquisition.binding.name, probeTimeoutMs, options.signal)
	} catch (err) {
		await runFailureCleanup(async (signal) => {
			await sandbox.destroy({ signal })
		})
		throw err
	}
	return sandbox
}

/**
 * Run the probe against a built Sandbox, on its own clock, and throw if it
 * refuses. Cleanup is the CALLER's, and the two callers want opposite things:
 * a task acquire destroys the instance, while `workspace.ts` suspends it,
 * because deleting a workspace deletes its disk and a probe refusal is not a
 * reason to lose a caller's files.
 */
export async function probeSandboxPrivileges(
	sandbox: Sandbox,
	sandboxName: string,
	probeTimeoutMs: number,
	signal?: AbortSignal,
): Promise<void> {
	// Labelled with the sandbox, so an expiry read off a log line says which
	// acquire stopped answering — and so the catch below can tell THIS
	// deadline from any other that might surface through the same exec.
	const probeLabel = `kubernetes privilege probe ${sandboxName}`
	try {
		signal?.throwIfAborted()
		// The deadline's signal covers both ways this should stop early: it
		// aborts on expiry, and it aborts with the caller's own reason when
		// `signal` does. Handing it to `exec` is what releases the guest-side
		// execution rather than merely abandoning the wait.
		await new OperationDeadline(probeTimeoutMs, probeLabel, signal).run(
			async (execSignal) =>
				await runPrivilegeProbe(
					async (command, args) => await sandbox.exec(command, args, { signal: execSignal }),
					sandboxName,
				),
		)
		// An abort that lands WHILE the probe is in flight must not leave a
		// live sandbox behind: the probe itself may well have finished, and
		// the caller who cancelled is about to stop holding the reference
		// that could destroy it. Same cleanup, one branch later.
		signal?.throwIfAborted()
	} catch (err) {
		// A caller who cancelled mid-probe gets THEIR reason, not the probe's
		// account of a command that was cancelled out from under it.
		signal?.throwIfAborted()
		// A probe that ran out of time is a probe that could not run, and is
		// refused in those words: `OperationDeadlineExpired` on its own would
		// leave a reader guessing which half of the acquire went quiet.
		if (err instanceof OperationDeadlineExpired && err.label === probeLabel) {
			throw privilegeProbeTimedOut(sandboxName, probeTimeoutMs, err)
		}
		throw err
	}
}
