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
 * created — by `egress-policy.ts`, in two steps. The NAMED object is GETted
 * and compared to the translation exactly, once, lazily, on the first
 * `create()`, so `buildKubernetesBackend` itself still contacts nothing.
 * Then, because the API server UNIONS every policy selecting a pod, every
 * `NetworkPolicy` in the namespace (and, under `engine: 'cilium'`, every
 * `CiliumNetworkPolicy`) is enumerated against the pod's real labels and the
 * create is refused when any of them lets out more than the translation does
 * — a second policy widens egress however exactly the named one matches, and
 * a `SandboxTemplate`'s own `networkPolicy` block becomes exactly such a
 * policy. `egress.verify: 'named-object-only'` is the opt-out and restores
 * the first step alone. Every Sandbox this file creates directly
 * (`buildSandboxBody`) carries {@link sandboxTemplateLabel} on its
 * podTemplate specifically so that translated policy's `podSelector` has
 * something stable to match — see `objects.ts`'s doc comment on that label
 * for why agent-sandbox's own controller-owned label does not cover this
 * path.
 *
 * ## Ingress
 *
 * `config.ingress` is the opposite default: verification is ON unless a
 * deployment says `'unverified'`. Before the POST for a direct Sandbox, and
 * after the bind for a claimed one, `ingress-policy.ts` lists the namespace's
 * policies and refuses unless one of them actually closes the agent port on
 * the labels this pod carries. Nothing checked that before, while three
 * pieces of shipped text said it was covered — see that module's own doc
 * comment for what was measured.
 */

import type { Sandbox, SandboxNetworkPolicy } from '@namzu/sdk'
import { generateSandboxId } from '@namzu/sdk'

import type { SandboxBackend, SandboxBackendOptions } from '../../index.js'
import {
	OperationDeadline,
	OperationDeadlineExpired,
	resolveReadinessOptions,
	runFailureCleanup,
} from '../readiness.js'
import {
	type EgressProfileLabel,
	type KubernetesEgressConfig,
	KubernetesPodLabelNotObservedError,
	KubernetesPodLabelsRejectedError,
	type KubernetesTranslatedEgressPolicy,
	assertEgressPolicyIsEnforceable,
	assertEgressProfileIsUsable,
	assertPerSandboxEgressIsUsable,
	composeAdditionalPodLabels,
	defaultEgressPolicyName,
	egressProfileLabel,
	egressUnionVerificationEnabled,
	perSandboxEgressLabelKey,
	translateEgressPolicy,
	verifyEgressPolicyApplied,
	verifyEgressPolicyUnion,
} from './egress-policy.js'
import {
	type KubernetesIngressConfig,
	ingressVerificationEnabled,
	resolveIngressEngine,
	verifyIngressPolicyApplied,
} from './ingress-policy.js'
import {
	type KubernetesAccess,
	KubernetesAlreadyGoneError,
	KubernetesApiError,
	KubernetesApiTimeoutError,
	type KubernetesClient,
	type KubernetesClientOptions,
	KubernetesCredentialError,
	createKubernetesClient,
} from './k8s-client.js'
import {
	type KubernetesCondition,
	type PodListResource,
	type PodResource,
	READY_CONDITION,
	SANDBOX_API_GROUP,
	SANDBOX_API_VERSION,
	SANDBOX_EXTENSIONS_API_GROUP,
	type SandboxClaimListResource,
	type SandboxClaimResource,
	type SandboxPodTemplate,
	type SandboxResource,
	type SandboxTemplateResource,
	type SandboxVolumeClaimTemplate,
	type SandboxWarmPoolResource,
	claimCollectionPath,
	claimListPath,
	claimPath,
	isConditionTrue,
	isPodLive,
	podCollectionPath,
	podListPath,
	podPath,
	readPodIP,
	sandboxCollectionPath,
	sandboxPath,
	sandboxTemplateLabel,
	sandboxTemplatePath,
	warmPoolPath,
} from './objects.js'
import {
	KubernetesOwnerUidMissingError,
	type PerSandboxPolicyOwner,
	buildAdmissionFence,
	buildPerSandboxPolicySetter,
} from './per-sandbox-policy.js'
import { privilegeProbeTimedOut, runPrivilegeProbe } from './privilege-probe.js'
import { buildKubernetesSandbox } from './sandbox.js'
import { KubernetesAgentTransport } from './transport.js'

export type {
	KubernetesEgressConfig,
	KubernetesEgressEngine,
	KubernetesEgressPolicy,
	KubernetesEgressVerification,
	KubernetesOnlyEgressPolicy,
	KubernetesPerSandboxEgressConfig,
} from './egress-policy.js'
export type { KubernetesIngressConfig, KubernetesIngressEngine } from './ingress-policy.js'

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
	/**
	 * Which of a sandbox's two addresses the transport dials. Default
	 * `'service'` — see {@link KubernetesAgentAddressMode}, which is where
	 * the choice is explained, because it is a fact about where the HOST
	 * runs rather than about the cluster.
	 */
	readonly agentAddress?: KubernetesAgentAddressMode
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
	 * neither computes nor verifies one, and OUTBOUND traffic is then whatever
	 * the cluster's own policies happen to allow.
	 *
	 * Deliberately not described as "covered by the SandboxTemplate's managed
	 * NetworkPolicy", which is what this comment used to claim: that policy
	 * selects `agents.x-k8s.io/sandbox-template-ref-hash`, a label the
	 * controller writes only onto a Sandbox adopted out of a `SandboxWarmPool`
	 * and never onto one this backend POSTs — so for every pool-less sandbox
	 * and every workspace it selects nothing at all. See `ingress-policy.ts`.
	 */
	readonly egress?: KubernetesEgressConfig
	/**
	 * Whether the agent port's INGRESS boundary is verified before a sandbox
	 * is created, and against which policy resources.
	 *
	 * Unset means VERIFY — the one field in this config whose absent value is
	 * the strict one, because the deployment that needs the check is the one
	 * that would never have set it. `'unverified'` reads no policy and issues
	 * no request, for a deployment whose boundary lives somewhere a namespaced
	 * Role cannot see. See `ingress-policy.ts`.
	 */
	readonly ingress?: KubernetesIngressConfig
	/**
	 * Bound on every single Kubernetes API request this backend sends. See
	 * {@link KubernetesClientOptions.requestTimeoutMs} in `k8s-client.ts`,
	 * which owns the default (30 s), the floor (1 s) and the reason there is
	 * no value that disables it.
	 */
	readonly apiRequestTimeoutMs?: number
	/**
	 * Interval of the negotiated liveness heartbeat on `openTerminal` and
	 * `openTcpConnection` streams. Default
	 * {@link DEFAULT_STREAM_HEARTBEAT_MS}; `0` turns it off and restores the
	 * pre-heartbeat behaviour exactly. See {@link resolveStreamHeartbeatMs}.
	 */
	readonly streamHeartbeatMs?: number
	/**
	 * Extra labels written onto every `SandboxClaim` this backend POSTs —
	 * `metadata.labels`, and nowhere else. Never merged into
	 * `additionalPodMetadata`: those are POD labels a running Sandbox and its
	 * `NetworkPolicy` selectors read, and a host's own recovery bookkeeping
	 * has no business changing what a pod is selected by. Absent means no
	 * labels beyond what the controller itself writes, and every claim body
	 * this backend sends is byte-for-byte what it always was.
	 *
	 * The intended use is a host-instance identity — e.g.
	 * `{ 'sandbox.namzu.ai/host-instance': hostId }` — so a restarted host
	 * can find and {@link releaseKubernetesTaskSandboxes} its predecessor's
	 * claims well before `claimTtlSeconds` would reap them on its own.
	 */
	readonly claimLabels?: Record<string, string>
}

/**
 * Default {@link KubernetesBackendInternalConfig.streamHeartbeatMs} — 15 s,
 * so a stream whose peer vanished without a FIN or an RST is given up on
 * within 45 s rather than never.
 *
 * The Kubernetes backend opts IN here; `VsockTransportOptions.heartbeatMs`
 * stays undefined by default, because that transport is shared with the
 * Firecracker tier and a default there would force-close an existing
 * consumer's quiet-but-alive terminal.
 */
export const DEFAULT_STREAM_HEARTBEAT_MS = 15_000

/**
 * Validate the configured stream-heartbeat interval, or supply the default.
 *
 * `0` IS accepted here, unlike `apiRequestTimeoutMs`: the heartbeat is a new
 * capability that a deployment behind a middlebox with its own idea about
 * unexpected frames may want off, and turning it off restores exactly the
 * behaviour every release before this one had. An unanswered API request has
 * no such prior behaviour worth restoring.
 */
export function resolveStreamHeartbeatMs(value: number | undefined): number {
	if (value === undefined) return DEFAULT_STREAM_HEARTBEAT_MS
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(
			`kubernetes: streamHeartbeatMs must be a non-negative integer, got ${JSON.stringify(
				value,
			)}. Use 0 to send no heartbeats at all, which is how every release before this one behaved; the default is ${DEFAULT_STREAM_HEARTBEAT_MS}ms.`,
		)
	}
	return value
}

/**
 * The client options every `createKubernetesClient` call in this backend is
 * built with. One function so the five call sites — the provider, and each
 * of the workspace verbs — cannot drift apart on which bounds they honour.
 */
export function clientOptions(config: KubernetesBackendInternalConfig): KubernetesClientOptions {
	return { requestTimeoutMs: config.apiRequestTimeoutMs }
}

/**
 * Which address a sandbox's agent is dialed at. A property of where the HOST
 * runs, not of the cluster.
 *
 *  - `'service'` (default) — the Sandbox's `status.serviceFQDN`,
 *    `<name>.<namespace>.svc.cluster.local`. It outlives the pod: a resumed
 *    workspace comes back behind the same name, and every dial re-resolves
 *    it. The catch is that only the cluster's own DNS answers it, so this is
 *    correct exactly when the host itself runs inside the cluster.
 *  - `'pod-ip'` — the bound pod's IP, read from the same `GET` that reads
 *    its uid, so the address and the bind token are always one pod's. For a
 *    host OUTSIDE the cluster on a routable pod network (a peered VNet, a
 *    node-local operator, a CI runner with a route): it needs no cluster
 *    resolver at all. The cost is that a pod IP dies with its pod, which is
 *    why a resume re-reads it and a connect failure re-reads it once.
 *
 * The cluster still decides whether either address is REACHABLE: `'pod-ip'`
 * additionally needs a NetworkPolicy that admits the host's own address
 * range on the agent port. Neither mode changes the bind token, the
 * privilege probe or egress verification.
 */
export type KubernetesAgentAddressMode = 'service' | 'pod-ip'

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
	/**
	 * Re-read the live pod and recompute {@link agent} from it. Present only
	 * under `agentAddress: 'pod-ip'`, where the address is a literal that
	 * dies with its pod; a Service FQDN needs no such thing, and handing one
	 * over anyway would give the default mode a re-read it never had.
	 */
	readonly refreshAgent?: (signal?: AbortSignal) => Promise<KubernetesAgentAddress>
	/** API path of the object THIS backend created — the claim, or the Sandbox. */
	readonly ownedPath: string
	/**
	 * The object this backend created, identified well enough to be named in
	 * another object's `ownerReferences`: its kind, its name and the uid the
	 * API server assigned it.
	 *
	 * Present only when `config.egress.perSandbox` is configured, because it
	 * is read from the create reply and the readiness polls and nothing else
	 * needs it — a deployment that never writes a per-sandbox policy should
	 * not start carrying a field whose absence would otherwise be a bug.
	 */
	readonly owner?: PerSandboxPolicyOwner
	/**
	 * The VALUE of the per-sandbox selector label on this sandbox's pod —
	 * the created object's name, confirmed on the bound pod before the
	 * sandbox was admitted. Present under the same condition as
	 * {@link owner}.
	 */
	readonly perSandboxLabelValue?: string
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
		assertEgressPolicyIsEnforceable(
			config.egress.policy,
			config.egress.engine ?? 'core',
			config.egress.ciliumNarrowing,
		)
	}
	// And the same for an egress PROFILE that could never be written as a
	// label — a value the API server would reject leaves either a claim
	// nothing binds or a policy nobody can apply, and both are decidable
	// from config alone.
	assertEgressProfileIsUsable(config.egress)
	// And the same for per-sandbox egress: an engine that cannot express a
	// hostname, an unnamed admission fence or a selector key the API server
	// would refuse are all decidable from config alone, and a host that
	// learns any of them from its first `setNetworkPolicy` call learns it an
	// hour into a run that cannot be redone.
	assertPerSandboxEgressIsUsable(config.egress)
	// Resolved here as well as at each session, so a configuration this
	// backend will never honour is refused while `buildKubernetesBackend` is
	// still on the stack rather than on someone's first `create()`.
	resolveStreamHeartbeatMs(config.streamHeartbeatMs)
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))
	// Verify-not-trust runs once, lazily, on the first `create()` — never here,
	// because `buildKubernetesBackend` is documented to contact nothing. A
	// failed attempt is not cached: a transient API error should not wedge
	// every later create() behind the same stale rejection forever. The
	// boundary object holds both halves and both memos; it lives as long as
	// this backend does, which is what makes the named-object check
	// once-per-backend rather than once-per-create.
	const egressBoundary = buildEgressBoundary(client, config, config.sandboxTemplateName)
	// Ingress is cached PER LABEL SET rather than once per backend, because
	// unlike the egress NAMED-object check it is a question about one pod: a
	// pooled sandbox's labels come off the pool's template and a pool-less
	// one's off this config, and a single memo would answer for a pod it never
	// examined. Same failure handling as the egress memo — a failed attempt is
	// dropped, so a transient API error does not wedge every later create()
	// behind it. The egress UNION check is keyed the same way, for the same
	// reason, and additionally expires: see {@link EGRESS_UNION_CACHE_TTL_MS}.
	const ingressVerifier = buildIngressVerifier(client, config, new Map())
	// One fence per backend, so its memo is shared by every sandbox this
	// backend hands out rather than re-proved per handle. `undefined` when
	// per-sandbox egress is not configured, which is what makes
	// `setNetworkPolicy` absent from the handle — presence follows
	// CONFIGURATION and never a runtime probe, so a caller's capability
	// detection cannot depend on when it asked.
	const perSandbox = config.egress?.perSandbox
	const fence = perSandbox === undefined ? undefined : buildAdmissionFence(client, perSandbox)
	return {
		tier: 'microvm',
		name: 'kubernetes',
		async create(options: SandboxBackendOptions): Promise<Sandbox> {
			await egressBoundary?.verifyNamedObject(options.signal)
			const acquisition = await acquireKubernetesSandbox(
				client,
				config,
				options,
				readiness,
				ingressVerifier,
				egressBoundary,
			)
			const egress = config.egress
			const setNetworkPolicy =
				fence !== undefined &&
				egress?.perSandbox !== undefined &&
				acquisition.owner !== undefined &&
				acquisition.perSandboxLabelValue !== undefined
					? buildPerSandboxPolicySetter({
							client,
							fence,
							namespace: config.namespace,
							egress: { ...egress, perSandbox: egress.perSandbox },
							owner: acquisition.owner,
							selectorValue: acquisition.perSandboxLabelValue,
						})
					: undefined
			return await admitProbedSandbox(
				acquisition,
				config,
				options,
				resolveProbeTimeoutMs(readiness.timeoutMs),
				setNetworkPolicy,
			)
		},
	}
}

/**
 * The two egress checks a create path runs, with their memos.
 *
 * `undefined` when `config.egress` is unset — the whole boundary is one
 * absent object rather than a flag every call site re-reads, the same shape
 * {@link IngressVerifier} uses for its own opt-out.
 *
 * Exported because `workspace.ts` runs the identical steps: a workspace does
 * not go through `buildKubernetesBackend`, and a config `egress` honoured on
 * one entry point and ignored on the other would be a silent downgrade of the
 * boundary this backend calls primary. It builds its own boundary per create,
 * which is what makes its checks per-call rather than memoized — creating a
 * workspace is a rare, explicit act with nothing to amortise, and a policy
 * deleted since the last call must be noticed.
 */
export interface KubernetesEgressBoundary {
	/**
	 * Translate `egress.policy` and confirm an operator applied a matching
	 * object — the original verify-not-trust step, unchanged, including its
	 * exact-match comparison and its once-per-boundary memo.
	 */
	verifyNamedObject(signal?: AbortSignal): Promise<void>
	/**
	 * Enumerate every policy selecting THIS pod and refuse when any of them
	 * allows egress the translation does not. A no-op under
	 * `egress.verify: 'named-object-only'`.
	 */
	verifyUnion(
		podLabels: Readonly<Record<string, string>>,
		subject: string,
		signal?: AbortSignal,
	): Promise<void>
}

/**
 * How long a union pass is trusted for one label set.
 *
 * Five minutes rather than the backend's lifetime, which is what the
 * named-object check alone used to get: an operator who applies a widening
 * policy at 10:00 should not have it go unnoticed until the host restarts.
 * It is a cache, not a watch — `k8s-client.ts`'s "no watch, no informers, no
 * resourceVersion tracking" invariant is untouched, because the only thing
 * kept across calls is "this exact label set passed at this time".
 */
export const EGRESS_UNION_CACHE_TTL_MS = 5 * 60 * 1_000

/** One cached pass, and when it was taken. */
interface CachedPass {
	readonly at: number
	readonly pending: Promise<void>
}

/**
 * Build the egress boundary this config asks for, or nothing at all.
 *
 * `sandboxTemplateName` is the template the caller is actually building from
 * — it decides both the default policy name and the pod label the policy's
 * selector has to match, and a workspace may be built from a different
 * template than the task path's.
 *
 * `now` is injected only so the TTL above can be tested without waiting five
 * minutes; nothing else passes it.
 */
export function buildEgressBoundary(
	client: KubernetesClient,
	config: KubernetesBackendInternalConfig,
	sandboxTemplateName: string,
	now: () => number = Date.now,
): KubernetesEgressBoundary | undefined {
	const egress = config.egress
	if (egress === undefined) return undefined
	const engine = egress.engine ?? 'core'
	// One resolution of the profile, shared by the policy NAME and the policy
	// SELECTOR: under a profile the default name gains the profile segment
	// (one template under two profiles is two policy objects) and the
	// selector gains the label, and the two must not be able to disagree.
	const profile = egressProfileLabel(egress)
	const target = {
		namespace: config.namespace,
		name: egress.networkPolicyName ?? defaultEgressPolicyName(sandboxTemplateName, profile?.value),
		sandboxTemplateName,
		...(profile !== undefined ? { profile } : {}),
	}
	// Translated ONCE per boundary, not once per check: a `resolver` policy's
	// `resolve()` is the host's own closure and may cost a network call, and
	// running the two checks against two independently resolved allowlists
	// would compare each against a different translation.
	let translation: Promise<KubernetesTranslatedEgressPolicy> | undefined
	const translate = (): Promise<KubernetesTranslatedEgressPolicy> => {
		translation ??= translateEgressPolicy(
			egress.policy,
			engine,
			target,
			egress.ciliumNarrowing,
		).catch((err: unknown) => {
			translation = undefined
			throw err
		})
		return translation
	}
	let namedObject: Promise<void> | undefined
	const passes = new Map<string, CachedPass>()
	// The per-sandbox selector label carries a once-ever value, so it is
	// excluded from the memo key — see {@link policyCacheKey}. Resolved once
	// here rather than per check, because the resolver validates as it
	// resolves and a per-check throw would surface from a cache lookup.
	const perSandboxKey = perSandboxEgressLabelKey(egress)
	return {
		async verifyNamedObject(signal) {
			namedObject ??= (async () => {
				await verifyEgressPolicyApplied(client, await translate(), signal)
			})().catch((err: unknown) => {
				namedObject = undefined
				throw err
			})
			await namedObject
		},
		async verifyUnion(podLabels, subject, signal) {
			if (!egressUnionVerificationEnabled(egress)) return
			const translated = await translate()
			const key = policyCacheKey(podLabels, perSandboxKey)
			const cached = passes.get(key)
			if (cached !== undefined && now() - cached.at < EGRESS_UNION_CACHE_TTL_MS) {
				await cached.pending
				return
			}
			const pending = verifyEgressPolicyUnion(
				client,
				translated,
				{ namespace: config.namespace, podLabels, engine, subject },
				signal,
			).catch((err: unknown) => {
				// A failed attempt is never cached — same rule the named-object
				// memo has always had.
				passes.delete(key)
				throw err
			})
			passes.set(key, { at: now(), pending })
			await pending
		},
	}
}

/**
 * What a create path calls to prove the agent port is closed before it hands
 * a sandbox back. `undefined` when `config.ingress` is `'unverified'`, so the
 * opt-out is one absent function rather than a flag every call site re-reads.
 */
export type IngressVerifier = (
	podLabels: Readonly<Record<string, string>>,
	subject: string,
	signal?: AbortSignal,
) => Promise<void>

/**
 * Canonical key for one label set — order-independent, so two spellings of
 * the same pod share a memo.
 *
 * `excludeKey` drops the PER-SANDBOX egress label, whose value is unique per
 * acquire. Both memos exist to amortise a namespace-wide policy enumeration
 * across every sandbox a backend produces, and a key that carried a
 * once-ever value would give every acquire a miss and leave an entry behind
 * that nothing ever looks up again — a full enumeration per sandbox, and a
 * Map that grows for the host's whole life.
 *
 * Dropping it is sound at the moment these checks run: the only policy that
 * could select a pod BY that key and value is that sandbox's own, whose name
 * is generated in the same call and which does not exist yet. Every other
 * policy selecting the pod — the operator's baseline, a per-profile one,
 * anything hand-written — selects on the labels that remain, so two pods
 * differing only in this label are the same question. The label itself is
 * still PRESENT in the label set each check is run against; only the memo's
 * key ignores it.
 */
function policyCacheKey(podLabels: Readonly<Record<string, string>>, excludeKey?: string): string {
	return JSON.stringify(
		Object.entries(podLabels)
			.filter(([k]) => k !== excludeKey)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	)
}

/**
 * Build the ingress check this config asks for, or nothing at all.
 *
 * `cache` is the provider path's per-label-set memo; a workspace passes none,
 * and re-checks on every call for the same reason its egress check does —
 * creating a workspace is a rare, explicit act with nothing to amortise, and
 * a policy deleted since the last call must be noticed.
 */
export function buildIngressVerifier(
	client: KubernetesClient,
	config: KubernetesBackendInternalConfig,
	cache?: Map<string, Promise<void>>,
): IngressVerifier | undefined {
	if (!ingressVerificationEnabled(config.ingress)) return undefined
	const engine = resolveIngressEngine(config.ingress, config.egress?.engine)
	const agentPort = config.agentPort ?? DEFAULT_AGENT_PORT
	// Same exclusion, same reason, as the egress union memo above: a
	// once-ever label value in the key would make this memo a per-acquire
	// miss and an unbounded Map. See {@link policyCacheKey}.
	const perSandboxKey = perSandboxEgressLabelKey(config.egress)
	return async (podLabels, subject, signal) => {
		const target = { namespace: config.namespace, podLabels, agentPort, engine, subject }
		if (cache === undefined) {
			await verifyIngressPolicyApplied(client, target, signal)
			return
		}
		const key = policyCacheKey(podLabels, perSandboxKey)
		let pending = cache.get(key)
		if (pending === undefined) {
			pending = verifyIngressPolicyApplied(client, target, signal).catch((err: unknown) => {
				cache.delete(key)
				throw err
			})
			cache.set(key, pending)
		}
		await pending
	}
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
 * Why an acquire was refused, in the terms an operator acts on rather than
 * the terms the failure happened to arrive in.
 *
 *  - `'api-unreachable'` — the API server could not be reached, or kept
 *    answering with a status that means "not now": a connect failure, a 429,
 *    a 5xx. Retried inside the readiness budget before it ever reaches a
 *    caller, so seeing it means the whole budget was spent failing.
 *  - `'api-timeout'` — requests were accepted and never answered, until
 *    `apiRequestTimeoutMs` gave up on them. Also retried first.
 *  - `'forbidden'` — 401 or 403. The host's ServiceAccount cannot do this;
 *    no amount of waiting changes that. See the RBAC section of
 *    `docs/sdk/kubernetes-sandbox.md`.
 *  - `'claim-rejected'` — the controller REFUSED the claim, and said why.
 *    {@link KubernetesAcquireError.controllerReason} carries its own word for
 *    it. This is the one that used to burn the entire readiness budget before
 *    failing.
 *  - `'capacity'` — the pod exists and cannot be placed: the scheduler
 *    reports `PodScheduled=False` with reason `Unschedulable`. The cluster is
 *    full, or nothing matches the template's placement rules.
 *  - `'image-pull'` — the pod was placed and its container cannot start
 *    because the image will not pull. Permanent until an operator fixes the
 *    reference or the pull credential.
 *  - `'not-ready'` — none of the above: the readiness budget expired with the
 *    cluster reporting nothing wrong. A slow cold start, a webhook, an
 *    admission controller, a CNI that never attached the pod.
 */
export type KubernetesAcquireFailureReason =
	| 'api-unreachable'
	| 'api-timeout'
	| 'forbidden'
	| 'claim-rejected'
	| 'capacity'
	| 'image-pull'
	| 'not-ready'

/**
 * An acquire that was refused, carrying WHY in a field rather than in prose.
 *
 * Before this class a burst past node capacity and an API outage were the
 * same plain `Error`, and a host could only tell them apart by matching
 * message text that any release is free to reword. `reason` is the diagnosis,
 * `retryable` is the advice that follows from it, and `cause` is the original
 * failure — unmodified, so a host that already catches
 * {@link ReadinessPollTimeout}, {@link KubernetesApiTimeoutError} or
 * `KubernetesCredentialError` finds it there.
 *
 * `retryable` is about THIS acquire being worth attempting again, not about
 * anything having been retried. Transient API failures are already retried
 * inside the readiness budget, so a `retryable: true` that reaches a caller
 * means the whole budget was spent on them.
 *
 * Not every acquire failure becomes one of these, and that is deliberate: a
 * refusal this class cannot honestly diagnose — a malformed template, a 400
 * from an admission webhook, a controller that reported Ready and named no
 * sandbox — travels out as itself rather than being filed under whichever of
 * the seven reasons is least wrong. `KubernetesApiError` carries the status
 * for those.
 */
export class KubernetesAcquireError extends Error {
	override readonly name = 'KubernetesAcquireError'
	readonly reason: KubernetesAcquireFailureReason
	/** Whether attempting the same acquire again could plausibly succeed. */
	readonly retryable: boolean
	/**
	 * `status.conditions[Ready].reason`, verbatim, when the controller
	 * refused the claim — `WarmPoolNotFound`, `TemplateNotFound`,
	 * `InvalidMetadata`, `EnvVarsInjectionRejected`. Present only for
	 * `'claim-rejected'`.
	 */
	readonly controllerReason?: string
	/** The controller's own message for the same condition. */
	readonly controllerMessage?: string

	constructor(details: {
		readonly reason: KubernetesAcquireFailureReason
		readonly retryable: boolean
		readonly message: string
		readonly controllerReason?: string
		readonly controllerMessage?: string
		readonly cause?: unknown
	}) {
		super(details.message, details.cause !== undefined ? { cause: details.cause } : undefined)
		this.reason = details.reason
		this.retryable = details.retryable
		if (details.controllerReason !== undefined) this.controllerReason = details.controllerReason
		if (details.controllerMessage !== undefined) this.controllerMessage = details.controllerMessage
	}
}

/**
 * The `status.conditions[Ready].reason` values that mean the controller has
 * DECIDED, so waiting is pointless.
 *
 * ## Where these strings came from
 *
 * Not from the issue that asked for this, and not from upstream source: this
 * repo vendors none of agent-sandbox's Go, so a literal copied out of a
 * changelog is a literal nobody here can check. Each of the four was produced
 * against the deployed controller (kind v1.37.0, agent-sandbox v1.0.2,
 * 2026-09-17) by making the claim it describes and reading the condition
 * back:
 *
 * | reason | how it was produced | the controller's message |
 * |---|---|---|
 * | `WarmPoolNotFound` | claim at a pool that does not exist | `SandboxWarmPool "…" not found` |
 * | `TemplateNotFound` | claim at a pool whose template does not exist | `SandboxTemplate "…" not found` |
 * | `InvalidMetadata` | claim with an `additionalPodMetadata` label outside the allowed domains | `invalid additionalPodMetadata: …` |
 * | `EnvVarsInjectionRejected` | claim with `spec.env` against a template that forbids injection | `environment variable injection rejected: …` |
 *
 * The transient reasons seen on the SAME cluster, which must NOT be in this
 * set, were `DependenciesNotReady` (pod exists, still Pending) and
 * `DependenciesReady` (the Ready=True reason).
 *
 * ## Why an unknown reason is not terminal
 *
 * A wrong literal here fails in one of two ways, and only one of them is
 * recoverable. Too few entries: a rejected claim waits out the readiness
 * budget, which is exactly the behaviour every release before this one had.
 * Too many: an acquire that would have succeeded is refused on a guess. So
 * the set is a closed list of measured strings and everything else falls
 * through to the deadline.
 */
// Frozen because it is exported from the package root: an array handed to
// every consumer is one a cast can push onto, and an entry added there would
// change fail-fast for the whole process. The `readonly string[]` annotation
// is deliberate rather than `as const` — `includes` on a literal tuple only
// accepts the literals, and the whole point is to ask it about a reason no
// one here has seen.
export const TERMINAL_CLAIM_REASONS: readonly string[] = Object.freeze([
	'WarmPoolNotFound',
	'TemplateNotFound',
	'InvalidMetadata',
	'EnvVarsInjectionRejected',
])

/**
 * The `Ready` condition a claim reports, whatever its status — the one
 * {@link isConditionTrue} deliberately cannot return, because it answers a
 * boolean question and this one needs the reason.
 */
function readyCondition(
	conditions: readonly KubernetesCondition[] | undefined,
): KubernetesCondition | undefined {
	return conditions?.find((c) => c.type === READY_CONDITION)
}

/**
 * What this backend asked the controller to put on the claim's pod, carried
 * into the rejection so an `InvalidMetadata` refusal can say what was sent
 * and which knob changes it.
 *
 * Context, never a second decision: whether a claim is refused at all is
 * {@link TERMINAL_CLAIM_REASONS}' answer and nobody else's, so an empty map
 * changes nothing about the class thrown, the reason on it, or when it is
 * raised.
 */
export interface ClaimPodMetadataContext {
	readonly namespace: string
	/** `spec.additionalPodMetadata.labels`, exactly as sent. */
	readonly requestedPodLabels: Readonly<Record<string, string>>
	/** The egress profile among those labels, when one is configured. */
	readonly profile?: EgressProfileLabel
}

/**
 * A claim the controller has refused, or `undefined` for one it is still
 * working on.
 *
 * `status: 'False'` alone is not a refusal — it is also what a claim looks
 * like for the whole of a cold start — so the REASON decides, against
 * {@link TERMINAL_CLAIM_REASONS}.
 *
 * ONE class comes out of here whatever the reason, and that is deliberate:
 * `InvalidMetadata` is how the controller refuses a pod label whose domain is
 * not on its allowlist — the profile's, today — and a host's `catch` must not
 * have to be written differently depending on whether a profile happens to be
 * configured. `metadata` only decides what rides along as the `cause`: a
 * {@link KubernetesPodLabelsRejectedError} naming the map that was sent
 * and the `config.egress.profileLabelKey` that moves it, which the
 * controller's own message cannot know about.
 */
export function classifyClaimRejection(
	claim: SandboxClaimResource | undefined,
	claimName: string,
	metadata?: ClaimPodMetadataContext,
): KubernetesAcquireError | undefined {
	const condition = readyCondition(claim?.status?.conditions)
	if (condition === undefined || condition.status !== 'False') return undefined
	const reason = condition.reason
	if (reason === undefined || !TERMINAL_CLAIM_REASONS.includes(reason)) return undefined
	// Only for the reason the pod metadata can actually cause, and only when
	// this backend sent any: a `WarmPoolNotFound` carrying a labels-and-
	// allowlist explanation would send an operator after the wrong thing.
	const cause =
		reason === 'InvalidMetadata' &&
		metadata !== undefined &&
		Object.keys(metadata.requestedPodLabels).length > 0
			? new KubernetesPodLabelsRejectedError(
					metadata.requestedPodLabels,
					claimName,
					metadata.namespace,
					reason,
					condition.message ?? '(the controller reported no message)',
					metadata.profile,
				)
			: undefined
	return new KubernetesAcquireError({
		reason: 'claim-rejected',
		retryable: false,
		controllerReason: reason,
		...(condition.message !== undefined ? { controllerMessage: condition.message } : {}),
		...(cause !== undefined ? { cause } : {}),
		message: `kubernetes: the agent-sandbox controller refused SandboxClaim ${claimName} with reason ${reason}${
			condition.message !== undefined ? `: ${condition.message}` : ''
		}. That is a decision, not a delay, so the readiness budget was not waited out.${
			cause !== undefined ? ` ${cause.message}` : ''
		}`,
	})
}

/**
 * How long to wait before repeating a failed readiness read, or `undefined`
 * when the failure is not worth repeating.
 *
 * Retryable: a connect failure (the socket, not the answer), a request the
 * `apiRequestTimeoutMs` bound gave up on, a 429 (the API server's own
 * priority-and-fairness queue shedding load) and any 5xx. Not retryable: 401
 * and 403, which are a decision; 404 and 410, which are an answer; 409, which
 * a caller resolves by re-reading; and everything this backend threw itself.
 *
 * The wait is the poll's own cadence unless the server named one — then its
 * `Retry-After`, because the server knows when its queue drains and this code
 * does not. Nothing here consults a clock: the caller's deadline owns the
 * sleep, so a long `Retry-After` spends the readiness budget rather than
 * extending it.
 */
/**
 * The largest delay a timer can hold — `2^31 - 1` ms, Node's own ceiling.
 * Above it `setTimeout` warns and fires immediately, which is the opposite of
 * what a long `Retry-After` asked for.
 */
const MAX_RETRY_DELAY_MS = 2_147_483_647

export function retryDelayForApiFailure(err: unknown, pollIntervalMs: number): number | undefined {
	if (err instanceof KubernetesApiTimeoutError) return pollIntervalMs
	if (!(err instanceof KubernetesApiError)) return undefined
	if (err.transport === 'connect') return pollIntervalMs
	const status = err.status
	if (status === undefined) return undefined
	// `Retry-After` may only ever SLOW the poll down, and only within what a
	// timer can express. A header of `0`, or one naming a moment already past,
	// would otherwise turn the retry into a hot loop against a server that is
	// already shedding load — the caller's own cadence is the rate this loop
	// runs at when nothing is wrong. And a header naming a moment years away
	// overflows `setTimeout`, which then fires at once rather than never,
	// producing the same hot loop from the opposite direction. The readiness
	// deadline ends the wait either way; the clamp only stops the wait from
	// silently becoming no wait at all.
	if (status === 429 || status >= 500) {
		const asked = err.retryAfterMs ?? pollIntervalMs
		return Math.min(Math.max(asked, pollIntervalMs), MAX_RETRY_DELAY_MS)
	}
	return undefined
}

/**
 * How long the one diagnostic pod read after a failed acquire may take.
 *
 * Same shape and the same argument as `runFailureCleanup`'s grace: the
 * readiness clock has already expired, so this cannot share it, and a
 * diagnosis that could hang would keep `create()` pending past the budget the
 * caller chose — for a nicer error message. One second, and a diagnosis that
 * does not arrive is simply not made.
 */
const ACQUIRE_DIAGNOSIS_GRACE_MS = 1_000

/**
 * The image-pull `status.containerStatuses[].state.waiting.reason` values the
 * kubelet reports. Measured on kind v1.37.0 (2026-09-17): a container whose
 * image does not exist waits as `ErrImagePull` for the first attempts and
 * settles into `ImagePullBackOff`. The other two are the kubelet's names for
 * a pull that resolved and then failed, and for a registry that cannot be
 * reached at all.
 */
const IMAGE_PULL_WAITING_REASONS: readonly string[] = [
	'ErrImagePull',
	'ImagePullBackOff',
	'ImageInspectError',
	'RegistryUnavailable',
]

/**
 * Ask the pod why it is not ready, once, after the budget has already gone.
 *
 * Nothing on the healthy path calls this and nothing waits on it: it runs
 * exactly when an acquire has already failed, and its whole output is a
 * better {@link KubernetesAcquireFailureReason} than `'not-ready'`. A read
 * that fails, a pod that is not there and a pod with nothing to say all
 * produce `undefined`, which leaves the reason where it was.
 *
 * It must run BEFORE the cleanup DELETE, because the pod goes away with the
 * object it belongs to.
 *
 * It takes the CALLER's signal where `runFailureCleanup` deliberately does
 * not: cleanup must finish or the cluster keeps the object, while a diagnosis
 * is only a better sentence for an error a caller who aborted will never
 * read.
 */
async function diagnoseUnreadyPod(
	client: KubernetesClient,
	namespace: string,
	podName: string,
	callerSignal: AbortSignal | undefined,
): Promise<'capacity' | 'image-pull' | undefined> {
	let pod: PodResource | undefined
	try {
		const deadline = new OperationDeadline(
			ACQUIRE_DIAGNOSIS_GRACE_MS,
			'kubernetes acquire diagnosis',
			callerSignal,
		)
		pod = await deadline.run((signal) =>
			client.request<PodResource>('GET', podPath(namespace, podName), undefined, signal),
		)
	} catch {
		// The acquire failure is the primary one and keeps its reason. A
		// diagnosis that cannot be made is not a second failure to report.
		return undefined
	}
	const scheduled = pod?.status?.conditions?.find((c) => c.type === 'PodScheduled')
	if (scheduled?.status === 'False' && scheduled.reason === 'Unschedulable') return 'capacity'
	for (const container of pod?.status?.containerStatuses ?? []) {
		const reason = container.state?.waiting?.reason
		if (reason !== undefined && IMAGE_PULL_WAITING_REASONS.includes(reason)) return 'image-pull'
	}
	return undefined
}

/**
 * The refusal a caller sees, given the failure that actually happened and
 * whatever the pod had to say about it.
 *
 * Returns `undefined` for a failure none of the seven reasons describes —
 * see {@link KubernetesAcquireError} for why that is a deliberate hole rather
 * than a missing case. A {@link KubernetesAcquireError} that arrived from
 * deeper in (the claim rejection) is returned unchanged: it is already the
 * diagnosis.
 */
export function classifyAcquireFailure(
	err: unknown,
	podDiagnosis: 'capacity' | 'image-pull' | undefined,
): KubernetesAcquireError | undefined {
	if (err instanceof KubernetesAcquireError) return err
	if (err instanceof KubernetesApiTimeoutError) {
		return new KubernetesAcquireError({
			reason: 'api-timeout',
			retryable: true,
			message: `kubernetes: the acquire was refused because the API server did not answer in time — ${err.message}`,
			cause: err,
		})
	}
	if (err instanceof KubernetesCredentialError) {
		return new KubernetesAcquireError({
			reason: 'forbidden',
			retryable: false,
			message: `kubernetes: the acquire was refused because the API server rejected this host's credential — ${err.message}. Check the host ServiceAccount's Role against the RBAC section of the Kubernetes sandbox documentation.`,
			cause: err,
		})
	}
	if (err instanceof KubernetesApiError) {
		// The same predicate the poll retries on, so "worth trying again" has
		// one definition and a caller cannot be told a failure is retryable
		// that the poll would have declined to retry. The interval is
		// irrelevant here — only whether an answer comes back at all.
		if (retryDelayForApiFailure(err, 1) === undefined) return undefined
		return new KubernetesAcquireError({
			reason: 'api-unreachable',
			retryable: true,
			message: `kubernetes: the acquire was refused because the API server could not serve it — ${err.message}`,
			cause: err,
		})
	}
	if (err instanceof ReadinessPollTimeout) {
		// ORDER MATTERS, and this is the order: what the cluster SAID beats
		// what the failures suggest. A pod diagnosis is a condition the API
		// server published about this pod, read after the budget had already
		// gone; `err.cause` is at best the failure the poll was still meeting
		// at that moment. On a saturated cluster both are present at once — a
		// pod nothing can schedule AND an API server shedding load — and
		// reporting `api-unreachable` there would hide the very reason this
		// function exists to produce, and would turn `image-pull`'s
		// `retryable: false` into a `true` that has a host retrying forever
		// against an image reference that will never resolve. A diagnosis also
		// cannot be stale in the way a cause can: it only exists because the
		// API server answered one more read, moments ago.
		if (podDiagnosis === 'capacity') {
			return new KubernetesAcquireError({
				reason: 'capacity',
				retryable: true,
				message: `kubernetes: the acquire was refused because its pod could not be scheduled — the cluster reports PodScheduled=False/Unschedulable. ${err.message}`,
				cause: err,
			})
		}
		if (podDiagnosis === 'image-pull') {
			return new KubernetesAcquireError({
				reason: 'image-pull',
				retryable: false,
				message: `kubernetes: the acquire was refused because its pod's container image will not pull. ${err.message}`,
				cause: err,
			})
		}
		// Nothing measured, so the failures the poll kept meeting decide: a
		// poll that spent its budget retrying API failures did not fail
		// because the sandbox was slow; it failed because the control plane
		// was. `pollForBinding` carries the failure it was STILL meeting onto
		// the timeout, and the reason follows it rather than the timeout.
		const underlying = classifyAcquireFailure(err.cause, undefined)
		if (underlying !== undefined) {
			return new KubernetesAcquireError({
				reason: underlying.reason,
				retryable: underlying.retryable,
				message: underlying.message,
				cause: err,
			})
		}
		return new KubernetesAcquireError({
			reason: 'not-ready',
			retryable: true,
			message: err.message,
			cause: err,
		})
	}
	if (err instanceof OperationDeadlineExpired) {
		return new KubernetesAcquireError({
			reason: 'not-ready',
			retryable: true,
			message: `kubernetes: the acquire ran out of readiness budget — ${err.message}`,
			cause: err,
		})
	}
	return undefined
}

/**
 * Claim or create, wait for Ready, read the bound identity back, resolve the
 * address and learn the pod's uid — or leave nothing behind trying.
 *
 * Exported because the sandbox surface is built on top of this record rather
 * than beside it: one acquire path, one cleanup path, whatever ends up
 * wrapping them.
 *
 * ## What it refuses with
 *
 * Every refusal this function can diagnose arrives as a
 * {@link KubernetesAcquireError} naming one of seven reasons, with the
 * original failure as its `cause`. Three things stay outside that:
 * configuration refused before anything is created
 * ({@link assertEnforceable}, {@link assertRuntimeClassIsApplicable}), a
 * caller's own abort, and a failure none of the seven reasons honestly
 * describes — see {@link KubernetesAcquireError} for why the last one is a
 * hole on purpose.
 *
 * ## What it retries, and what it will not
 *
 * A readiness GET that fails transiently — a connect failure, a request the
 * API bound gave up on, a 429, a 5xx — is repeated INSIDE the readiness
 * deadline, honouring `Retry-After`. One clock, so a retry spends the budget
 * rather than extending it, and a `create()` cannot outlive the timeout its
 * caller chose. The create POST is never retried: it is not idempotent, and a
 * POST whose answer never arrived may already have committed — which is why
 * cleanup deletes the client-owned name whatever happened.
 */
export async function acquireKubernetesSandbox(
	client: KubernetesClient,
	config: KubernetesBackendInternalConfig,
	options: SandboxBackendOptions,
	readiness: { readonly timeoutMs: number; readonly pollIntervalMs: number },
	verifyIngress: IngressVerifier | undefined = buildIngressVerifier(client, config),
	egressBoundary: KubernetesEgressBoundary | undefined = buildEgressBoundary(
		client,
		config,
		config.sandboxTemplateName,
	),
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
	// Composed ONCE, here, and handed to whichever body builder runs below:
	// the claim's `additionalPodMetadata.labels` and a direct Sandbox's pod
	// template metadata are the same map, and the translated policy's selector
	// is built from the same resolution. See `composeAdditionalPodLabels`.
	// Empty — the only case before a profile is configured — means every body
	// below is byte for byte what it was.
	// The per-sandbox selector label rides in the SAME map, through the same
	// composer, as a second key rather than a second construction — the whole
	// reason `composeAdditionalPodLabels` takes an `extra`. Its value is the
	// name of the object this acquire is about to create, which is unique per
	// acquire and known BEFORE the POST: that is what lets the label travel as
	// claim-time pod metadata (warm-safe, no cold start) instead of as a patch
	// to a running pod this backend has no verb for.
	const perSandboxLabelKey = perSandboxEgressLabelKey(config.egress)
	const podLabels = composeAdditionalPodLabels(
		config.egress,
		perSandboxLabelKey !== undefined ? { [perSandboxLabelKey]: objectName } : undefined,
	)
	const profile = egressProfileLabel(config.egress)
	// Read off the create reply, and off the readiness polls if that reply
	// carried no object — it is the uid a per-sandbox policy's
	// `ownerReferences` names and the suffix of its name, so the cluster can
	// garbage-collect the policy with the object this backend owns.
	let ownerUid: string | undefined
	const buildCreateBody = async (): Promise<Record<string, unknown>> => {
		if (config.warmPoolName !== undefined) {
			return buildClaimBody({
				namespace,
				name: objectName,
				warmPoolName: config.warmPoolName,
				shutdownTime,
				...(config.claimLabels !== undefined ? { labels: config.claimLabels } : {}),
				podLabels,
			})
		}
		const template = await deadline.run((signal) =>
			readSandboxTemplate(client, namespace, config.sandboxTemplateName, signal),
		)
		// A direct Sandbox's pod labels are decided HERE, by the body below,
		// so both network boundaries are checked against the real labels before
		// anything is created — a refusal leaves no Sandbox and no PVC behind
		// rather than one of each to clean up. This is EARLIER than the plan
		// for the egress union check asked for (it said "after binding", for
		// the bound pod's labels); a pool-less Sandbox's labels are knowable
		// before the POST, and refusing with nothing created is strictly
		// better than refusing with an object to clean up.
		const directPodLabels = sandboxPodLabels(template, config.sandboxTemplateName, podLabels)
		const directSubject = `to create Sandbox ${objectName} in namespace ${namespace}`
		if (verifyIngress !== undefined) {
			await deadline.run((signal) => verifyIngress(directPodLabels, directSubject, signal))
		}
		if (egressBoundary !== undefined) {
			await deadline.run((signal) =>
				egressBoundary.verifyUnion(directPodLabels, directSubject, signal),
			)
		}
		return buildSandboxBody({
			namespace,
			name: objectName,
			template,
			sandboxTemplateName: config.sandboxTemplateName,
			shutdownTime,
			podLabels,
			...(config.runtimeClassName !== undefined
				? { runtimeClassName: config.runtimeClassName }
				: {}),
		})
	}

	let createBody: Record<string, unknown>
	try {
		createBody = await buildCreateBody()
	} catch (err) {
		// Nothing exists yet, so there is nothing to clean up and no pod to
		// ask — but a 403 on the template read is still a `forbidden` acquire,
		// and a caller should not have to tell that apart by where it
		// happened.
		throw classifyAcquireFailure(err, undefined) ?? err
	}

	// The pod the diagnosis below asks, when there is one. A directly created
	// Sandbox is backed by a pod of its own name; a CLAIM's pod is not knowable
	// until the controller has named a sandbox in `status.sandbox`, which it
	// does before Ready on a cold start and never on a rejected claim.
	let diagnosablePodName: string | undefined =
		config.warmPoolName !== undefined ? undefined : objectName
	// One definition of "worth trying again", shared by the poll that retries
	// and the classification that reports — see {@link retryDelayForApiFailure}.
	const pollBehaviour: ReadinessPollBehaviour = {
		retryDelayFor: (err) => retryDelayForApiFailure(err, readiness.pollIntervalMs),
	}

	try {
		// Inside the cleanup block: a POST that fails client-side may still have
		// committed, so the only safe assumption is that the object exists.
		const created = await deadline.run((signal) =>
			client.request<{ readonly metadata?: { readonly uid?: string } }>(
				'POST',
				createPath,
				createBody,
				signal,
			),
		)
		ownerUid ??= created?.metadata?.uid
		const binding =
			config.warmPoolName !== undefined
				? await pollForBinding(
						async (signal) => {
							const claim = await client.request<SandboxClaimResource>(
								'GET',
								claimPath(namespace, objectName),
								undefined,
								signal,
							)
							diagnosablePodName = claim?.status?.sandbox?.name ?? diagnosablePodName
							ownerUid ??= claim?.metadata?.uid
							// The pod labels this backend asked the controller for
							// travel into the read, not because the fail-fast needs
							// them — `InvalidMetadata` is already one of
							// `TERMINAL_CLAIM_REASONS`, and that is the ONE
							// taxonomy a refused claim is reported under — but so
							// the refusal can carry what was actually sent and how
							// to change it. See {@link ClaimPodMetadataContext}.
							return bindingFromClaim(claim, objectName, {
								namespace,
								requestedPodLabels: podLabels,
								...(profile !== undefined ? { profile } : {}),
							})
						},
						deadline,
						readiness,
						`claim ${objectName}`,
						pollBehaviour,
					)
				: await pollForBinding(
						async (signal) => {
							const sandbox = await client.request<SandboxResource>(
								'GET',
								sandboxPath(namespace, objectName),
								undefined,
								signal,
							)
							ownerUid ??= sandbox?.metadata?.uid
							return bindingFromSandbox(sandbox)
						},
						deadline,
						readiness,
						`sandbox ${objectName}`,
						pollBehaviour,
					)

		const agentPort = config.agentPort ?? DEFAULT_AGENT_PORT
		const mode = config.agentAddress ?? 'service'
		// One read, two facts: the bind token and — under `'pod-ip'` — the
		// address, off the same pod. See {@link readAddressedPod}, which under
		// a configured profile also waits for the label the controller
		// patches onto the bound pod before anything is admitted.
		const pod = await readAddressedPod(
			client,
			namespace,
			binding,
			deadline,
			readiness,
			mode,
			podLabels,
		)
		// The one refusal this capability must not skip: an unlabelled pod
		// handed back runs under whatever policy DOES select it while the host
		// believes it is on a narrower profile. This throws INSIDE the try
		// block, so the cleanup below releases the claim (or deletes the
		// Sandbox) exactly as a failed privilege probe does — and the probe
		// itself, which runs in `admitProbedSandbox` after this function
		// returns, is therefore never reached with the label unobserved.
		assertRequestedPodLabelsObserved(
			pod,
			podLabels,
			`Sandbox ${binding.name} in namespace ${namespace}`,
		)
		// A CLAIMED sandbox's pod was built from the pool's own template, so
		// its labels are not knowable until the controller has bound one.
		// Checking here rather than not at all is the trade: a refusal
		// releases the claim through the cleanup below, which is the same
		// path a failed privilege probe takes.
		if (config.warmPoolName !== undefined) {
			const boundSubject = `the pod bound to Sandbox ${binding.name} in namespace ${namespace}`
			if (verifyIngress !== undefined) {
				await deadline.run((signal) => verifyIngress(pod.labels ?? {}, boundSubject, signal))
			}
			// The egress union check asks the same question of the same labels
			// — which policies select THIS pod — so it runs at the same two
			// points, and a refusal here releases the claim through the cleanup
			// below, exactly as a failed privilege probe does.
			if (egressBoundary !== undefined) {
				await deadline.run((signal) =>
					egressBoundary.verifyUnion(pod.labels ?? {}, boundSubject, signal),
				)
			}
		}
		// Only when the capability is configured, and only after the pod has
		// been confirmed to carry the selector label: a policy written for a
		// pod that never got the label would select nothing while the caller
		// was told its egress had been narrowed.
		const owner =
			perSandboxLabelKey === undefined
				? undefined
				: {
						kind: (config.warmPoolName !== undefined ? 'SandboxClaim' : 'Sandbox') as
							| 'SandboxClaim'
							| 'Sandbox',
						name: objectName,
						uid: assertOwnerUid(ownerUid, objectName, namespace),
					}
		return {
			binding,
			agent: resolveAgentAddress(binding, agentPort, pod.uid, {
				mode,
				...(pod.podIP !== undefined ? { podIP: pod.podIP } : {}),
			}),
			// Only the literal-address mode gets one — see the field.
			...(mode === 'pod-ip'
				? { refreshAgent: buildAgentAddressRefresh(client, namespace, binding, agentPort, mode) }
				: {}),
			ownedPath,
			...(owner !== undefined ? { owner, perSandboxLabelValue: objectName } : {}),
			ttlSeconds,
			release,
			renew,
		}
	} catch (err) {
		// Asked BEFORE cleanup, because the pod goes away with the object, and
		// only for a timeout — every other failure already knows what it was.
		const podDiagnosis =
			err instanceof ReadinessPollTimeout && diagnosablePodName !== undefined
				? await diagnoseUnreadyPod(client, namespace, diagnosablePodName, options.signal)
				: undefined
		// One cleanup for every way out of the block above, on its own short
		// budget: the readiness clock has already expired in the common case,
		// so spending it again would either skip cleanup or leave `create()`
		// pending without a bound. An object that is already gone is success.
		await runFailureCleanup(async (signal) => {
			await release(signal)
		})
		throw classifyAcquireFailure(err, podDiagnosis) ?? err
	}
}

/**
 * The claim body, in full. Everything absent from it is absent on purpose: no
 * `env` and no `volumeClaimTemplates`, because either forces a cold start
 * upstream and takes the warm pool away. `additionalPodMetadata` is the one
 * piece of claim-time metadata that does NOT — see `podLabels` below.
 *
 * `shutdownTime` + `shutdownPolicy: 'Delete'` is the leak guard: it bounds the
 * object by the wall clock whatever the host does, so a host that dies
 * mid-acquire costs the cluster one TTL rather than one leaked sandbox
 * forever. `ttlSecondsAfterFinished` deliberately does NOT appear — its timer
 * starts from the Finished condition, which a crashed host never reaches.
 *
 * `labels` (from {@link KubernetesBackendInternalConfig.claimLabels}) is the
 * host's own bookkeeping and goes ONLY onto `metadata.labels` — never into
 * `additionalPodMetadata`, because those are POD labels that change what
 * selectors match a running sandbox, and a host's crash-recovery identity has
 * no business doing that. Absent or empty, the body is exactly what it was
 * before `claimLabels` existed.
 *
 * `podLabels` is the other map, on the other object: whatever
 * `composeAdditionalPodLabels` produced — the egress profile today — which
 * the controller merges onto the pod it binds. It is the one piece of
 * claim-time metadata that does NOT cost a cold start, which is why `env` and
 * `volumeClaimTemplates` are still absent from this body and this is not.
 * Empty, `additionalPodMetadata` does not appear at all and the body is byte
 * for byte what it always was.
 */
interface ClaimBodyOptions {
	readonly namespace: string
	readonly name: string
	readonly warmPoolName: string
	readonly shutdownTime: string
	/** `metadata.labels` on the CLAIM. See above. */
	readonly labels?: Record<string, string>
	/** `spec.additionalPodMetadata.labels` — the POD's. See above. */
	readonly podLabels?: Readonly<Record<string, string>>
}

function buildClaimBody(options: ClaimBodyOptions): Record<string, unknown> {
	const { labels, podLabels } = options
	return {
		apiVersion: `${SANDBOX_EXTENSIONS_API_GROUP}/${SANDBOX_API_VERSION}`,
		kind: 'SandboxClaim',
		metadata: {
			name: options.name,
			namespace: options.namespace,
			...(labels !== undefined && Object.keys(labels).length > 0 ? { labels } : {}),
		},
		spec: {
			warmPoolRef: { name: options.warmPoolName },
			...(podLabels !== undefined && Object.keys(podLabels).length > 0
				? { additionalPodMetadata: { labels: podLabels } }
				: {}),
			lifecycle: { shutdownTime: options.shutdownTime, shutdownPolicy: 'Delete' },
		},
	}
}

/**
 * Refuse a bound pod that does not carry EVERY label this backend asked the
 * controller to put on it — the egress profile today, and whatever else
 * `composeAdditionalPodLabels` later contributes to the same map.
 *
 * The same set {@link readAddressedPod} waits for, deliberately: a wait that
 * covered more than the refusal would burn the readiness budget on a label
 * nothing then checked, and a refusal that covered more than the wait would
 * refuse a pod that had simply not been patched yet. An empty map (the
 * unprofiled path) checks nothing and returns.
 *
 * Called after {@link readAddressedPod} has already waited on the readiness
 * deadline, so reaching a missing label here means it never arrived, not that
 * it had not arrived yet.
 */
function assertRequestedPodLabelsObserved(
	pod: KubernetesBoundPod,
	requested: Readonly<Record<string, string>>,
	subject: string,
): void {
	for (const [key, value] of Object.entries(requested)) {
		if (pod.labels?.[key] === value) continue
		throw new KubernetesPodLabelNotObservedError({ key, value }, subject, pod.labels ?? {})
	}
}

/**
 * The uid of the object this acquire created, or a refusal naming what was
 * missing.
 *
 * Only reached when `config.egress.perSandbox` is configured, and only after
 * a create reply and every readiness poll have been read without one — the
 * API server assigns `metadata.uid` on admission and returns the object it
 * created, so an object with no uid is an API server that answered something
 * other than what it was asked for. Refusing is right: without the uid there
 * is no owner reference, and a per-sandbox policy with no owner is one the
 * cluster never collects.
 */
function assertOwnerUid(uid: string | undefined, objectName: string, namespace: string): string {
	if (uid !== undefined && uid !== '') return uid
	throw new KubernetesOwnerUidMissingError(objectName, namespace)
}

/**
 * Options for {@link releaseKubernetesTaskSandboxes}.
 */
export interface KubernetesReleaseTaskSandboxesOptions {
	/**
	 * Required, and refused if empty — see {@link releaseKubernetesTaskSandboxes}.
	 * The same selector syntax a `kubectl get --selector` takes, e.g.
	 * `sandbox.namzu.ai/host-instance=host-a`.
	 */
	readonly labelSelector: string
	readonly signal?: AbortSignal
}

/**
 * Recover a crashed host's claims: LIST every `SandboxClaim` carrying
 * `labelSelector`, `DELETE` each, and report what was removed.
 *
 * This deletes CLAIMS only. The controller's own garbage collection —
 * ownerReferences from claim to the Sandbox it bound, and from Sandbox to
 * Pod and Service — takes the rest down behind it; nothing here reads or
 * touches a Sandbox or a Pod directly. A claim already gone (raced by the
 * controller's own TTL reaper, or a second release call) counts as removed
 * rather than a failure, the same convention every other DELETE in this
 * backend follows.
 *
 * `labelSelector` is REQUIRED and refused, synchronously, before a single
 * request goes out, if it is absent or empty: a release that could fall back
 * to matching every claim (or every claim of the template) would delete a
 * live fleet's work the first time a caller passed one by mistake. There is
 * no default selector for exactly this reason.
 */
export async function releaseKubernetesTaskSandboxes(
	config: KubernetesBackendInternalConfig,
	options: KubernetesReleaseTaskSandboxesOptions,
): Promise<{ readonly deleted: number; readonly names: readonly string[] }> {
	if (options.labelSelector === '') {
		throw new Error(
			'kubernetes: releaseKubernetesTaskSandboxes requires a non-empty labelSelector — a release with no selector would delete every SandboxClaim in the namespace, including ones a live host still owns. Pass the selector that names only the claims you mean to recover.',
		)
	}
	options.signal?.throwIfAborted()
	const namespace = config.namespace
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))
	const list = await client.request<SandboxClaimListResource>(
		'GET',
		claimListPath(namespace, options.labelSelector),
		undefined,
		options.signal,
	)
	const names = (list?.items ?? [])
		.map((claim) => claim.metadata?.name)
		.filter((name): name is string => typeof name === 'string' && name !== '')
	// Concurrent, not one at a time: a crash-recovery release can carry a
	// whole host's worth of claims, and nothing here needs the ordering a
	// sequential loop would impose — each DELETE is independent and
	// idempotent (an already-gone claim is tolerated below). A non-tolerated
	// failure still rejects the whole call, exactly as a sequential loop
	// would have on its first such failure.
	await Promise.all(
		names.map(async (name) => {
			try {
				await client.request('DELETE', claimPath(namespace, name), undefined, options.signal)
			} catch (err) {
				if (!(err instanceof KubernetesAlreadyGoneError)) throw err
			}
		}),
	)
	return { deleted: names.length, names }
}

/** Result of {@link readKubernetesTaskCapacity}. */
export interface KubernetesTaskCapacity {
	/** `config.warmPoolName`'s own replica counts, straight off its `status`/`spec`. */
	readonly warmPool: {
		/** `status.readyReplicas`. `0` when the field is absent (a brand-new or empty pool). */
		readonly ready: number
		/** `spec.replicas`. `0` when the field is absent. */
		readonly desired: number
	}
	/** Every `SandboxClaim` in the namespace bound to `config.warmPoolName`, whatever its state. */
	readonly activeClaims: number
	/** Every Pod in the namespace currently in phase `Pending`. */
	readonly pendingPods: number
}

/** Options for {@link readKubernetesTaskCapacity}. */
export interface KubernetesReadTaskCapacityOptions {
	readonly signal?: AbortSignal
}

/**
 * Read task-pool headroom before admitting more work: three GETs, no writes.
 *
 * `config.warmPoolName` is required — this reads the exact object a claim's
 * `warmPoolRef` names, so a pool-less backend (every create is a direct
 * Sandbox) has no pool to report on. `activeClaims` is every claim in the
 * namespace whose `spec.warmPoolRef.name` matches this pool, counted rather
 * than trusted from a label, because a claim's `warmPoolRef` is the one
 * field the API itself guarantees. `pendingPods` is every Pod in the
 * namespace still in phase `Pending` — a coarse but honest signal of
 * in-flight scale-up the ready-replica count alone does not carry, on
 * either the warm or the pool-less path.
 */
export async function readKubernetesTaskCapacity(
	config: KubernetesBackendInternalConfig,
	options?: KubernetesReadTaskCapacityOptions,
): Promise<KubernetesTaskCapacity> {
	options?.signal?.throwIfAborted()
	if (config.warmPoolName === undefined) {
		throw new Error(
			'kubernetes: readKubernetesTaskCapacity requires config.warmPoolName — there is no SandboxWarmPool to report on for a backend that creates every sandbox directly.',
		)
	}
	const namespace = config.namespace
	const warmPoolName = config.warmPoolName
	const client = createKubernetesClient(clientAccess(config), clientOptions(config))
	const [pool, claims, pods] = await Promise.all([
		client.request<SandboxWarmPoolResource>(
			'GET',
			warmPoolPath(namespace, warmPoolName),
			undefined,
			options?.signal,
		),
		client.request<SandboxClaimListResource>(
			'GET',
			claimCollectionPath(namespace),
			undefined,
			options?.signal,
		),
		client.request<PodListResource>(
			'GET',
			podCollectionPath(namespace),
			undefined,
			options?.signal,
		),
	])
	const activeClaims = (claims?.items ?? []).filter(
		(claim) => claim.spec?.warmPoolRef?.name === warmPoolName,
	).length
	const pendingPods = (pods?.items ?? []).filter((pod) => pod.status?.phase === 'Pending').length
	return {
		warmPool: {
			ready: pool?.status?.readyReplicas ?? 0,
			desired: pool?.spec?.replicas ?? 0,
		},
		activeClaims,
		pendingPods,
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
	/**
	 * Annotations to stamp on the Sandbox's OWN metadata at creation.
	 *
	 * One caller, and everything it writes is a fact the object has to carry
	 * from the moment it exists rather than from its first patch: the holder
	 * epoch of a workspace created under one, so there is no window in which
	 * it stands unfenced, and the revision of the pod template it was built
	 * from, so there is no window in which it claims none. Both are
	 * `workspace.ts`'s — see `HOLDER_EPOCH_ANNOTATION_KEY` and
	 * `POD_TEMPLATE_HASH_ANNOTATION_KEY`.
	 *
	 * Absent, the body is byte for byte what it always was, which is what
	 * keeps every task sandbox's create unchanged — a task sandbox is
	 * ephemeral, so it has no revision to drift from and nothing to fence.
	 */
	readonly annotations?: Readonly<Record<string, string>>
	/**
	 * Extra labels stamped onto the POD template's metadata, beside the
	 * template label this body always adds.
	 *
	 * The same map `buildClaimBody` puts on a claim's
	 * `additionalPodMetadata.labels`, from the same
	 * `composeAdditionalPodLabels` call — a direct Sandbox has no controller
	 * to merge them for it, so the create body stamps them itself and the two
	 * paths produce one set of pod labels. Absent or empty, the pod template
	 * is byte for byte what it was.
	 */
	readonly podLabels?: Readonly<Record<string, string>>
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
	return {
		apiVersion: `${SANDBOX_API_GROUP}/${SANDBOX_API_VERSION}`,
		kind: 'Sandbox',
		metadata: {
			name: options.name,
			namespace: options.namespace,
			...(options.annotations !== undefined ? { annotations: options.annotations } : {}),
		},
		spec: {
			operatingMode: 'Running',
			service: true,
			...(options.shutdownTime !== undefined
				? { shutdownTime: options.shutdownTime, shutdownPolicy: 'Delete' }
				: {}),
			...(options.template.volumeClaimTemplates !== undefined
				? { volumeClaimTemplates: options.template.volumeClaimTemplates }
				: {}),
			podTemplate: sandboxPodTemplate(
				options.template,
				options.sandboxTemplateName,
				options.runtimeClassName,
				options.podLabels,
			),
		},
	}
}

/**
 * The `spec.podTemplate` a directly created Sandbox carries: the template's,
 * with this backend's overlays — the template label and whatever
 * {@link composeAdditionalPodLabels} produced ({@link sandboxPodLabels}), and
 * the configured `runtimeClassName`.
 *
 * Its own function because it is now built twice: once into the create POST
 * by {@link buildSandboxBody}, and once into the JSON Patch that refreshes a
 * standing workspace's pod template (`workspace.ts`). Two expressions of the
 * same overlay would drift, and the one that drifted would report a workspace
 * as off-template forever — the hash under
 * `sandbox.namzu.ai/pod-template-hash` is taken over exactly this object, so
 * a second spelling is a second revision.
 *
 * `podLabels` is on this signature rather than only on the create body for
 * exactly that reason. A refresh rewrites `/spec/podTemplate` WHOLE, so a
 * refresh built without them would PATCH the egress profile off a pod
 * template that carries it — the replacement pod would come up selected by no
 * per-profile policy, on a path where nothing re-checks the label, and the
 * revision stamped beside it would be taken over a template the POST never
 * writes, so `templateCurrent` would report drift forever.
 */
export function sandboxPodTemplate(
	template: SandboxTemplateCopy,
	sandboxTemplateName: string,
	runtimeClassName?: string,
	podLabels?: Readonly<Record<string, string>>,
): SandboxPodTemplate {
	const podTemplate = template.podTemplate
	const spec =
		runtimeClassName !== undefined
			? { ...podTemplate.spec, runtimeClassName }
			: { ...podTemplate.spec }
	return {
		...podTemplate,
		metadata: {
			...podTemplate.metadata,
			labels: sandboxPodLabels(template, sandboxTemplateName, podLabels),
		},
		spec,
	}
}

/**
 * The labels a directly created Sandbox's pod will carry: whatever the
 * template declares, plus this backend's own template label, which always
 * wins because it is the label a policy selector is built to match.
 *
 * Its own function because the ingress check has to reason about EXACTLY the
 * labels {@link buildSandboxBody} stamps, before the POST that stamps them.
 * Two expressions of the same rule would be one rename away from a check that
 * verifies a pod nobody creates.
 *
 * `extra` is `composeAdditionalPodLabels`'s map — the egress profile today.
 * It is applied LAST, and so wins over both, for the same reason the template
 * label wins over the copied template's own: it is a label the translated
 * policy's selector is built to match, and a pod that matched the selector
 * only sometimes would be a boundary that applied only sometimes.
 */
export function sandboxPodLabels(
	template: SandboxTemplateCopy,
	sandboxTemplateName: string,
	extra?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	return {
		...template.podTemplate.metadata?.labels,
		...sandboxTemplateLabel(sandboxTemplateName),
		...extra,
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
 * Its own function, and under the default mode the Service FQDN wins over a
 * pod IP, because that address outlives the pod: a suspended-then-resumed
 * workspace comes back as a new pod with a new IP behind the same name, and
 * the transport re-resolves the name on every dial. A literal IP baked into a
 * long-lived handle is the bug that would produce — and it is exactly the bug
 * `'pod-ip'` accepts, deliberately, in exchange for an address a host outside
 * the cluster can resolve at all. That mode pays for it by re-reading the IP
 * on every resume and once after a failed connect.
 *
 * `'pod-ip'` takes the address from `pod`, the record the bind token was just
 * read out of, and NEVER falls back to `binding.podIPs`. The Sandbox's status
 * is a second source that can name a different pod — the one a resume is
 * replacing — and an address from one pod with a token from another is the
 * mismatch that arrives as a flat `unauthorized`.
 */
export function resolveAgentAddress(
	binding: KubernetesSandboxBinding,
	agentPort: number,
	token: string,
	options: {
		readonly mode?: KubernetesAgentAddressMode
		/** The live pod the token came from. Required by `'pod-ip'`. */
		readonly podIP?: string
	} = {},
): KubernetesAgentAddress {
	if ((options.mode ?? 'service') === 'pod-ip') {
		const podIP = options.podIP
		if (podIP === undefined || podIP === '') {
			throw new Error(
				`kubernetes: sandbox ${binding.name} is configured with agentAddress: 'pod-ip', but the live pod its bind token was read from reported no status.podIP (nor a status.podIPs entry), so there is no address to dial. Every path that binds a pod POLLS for that address until the readiness deadline before this is reached — see readAddressedPod — so a pod that still reports none was never given one: a CNI that did not attach it, or a pod that never got past scheduling. Nothing is taken from the Sandbox's own status here on purpose — that IP may belong to a different pod than the token does.`,
			)
		}
		return { kind: 'tcp', host: podIP, port: agentPort, token }
	}
	const host = binding.serviceFQDN ?? binding.podIPs?.[0]
	if (host === undefined || host === '') {
		throw new Error(
			`kubernetes: sandbox ${binding.name} reported Ready with neither a serviceFQDN nor a pod IP, so its agent has no address to dial. Set 'service: true' on the SandboxTemplate the pool is built from.`,
		)
	}
	return { kind: 'tcp', host, port: agentPort, token }
}

/**
 * Ready-or-not-yet, read off a `SandboxClaim`'s own status — plus the one
 * "not yet" that is really a "no".
 *
 * The rejection check runs BEFORE the readiness check rather than after,
 * because a refused claim is `Ready=False` forever and the readiness check
 * cannot tell that from a cold start in progress. See
 * {@link classifyClaimRejection}.
 */
function bindingFromClaim(
	claim: SandboxClaimResource | undefined,
	claimName: string,
	metadata?: ClaimPodMetadataContext,
): KubernetesSandboxBinding | undefined {
	const rejection = classifyClaimRejection(claim, claimName, metadata)
	if (rejection !== undefined) throw rejection
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
 * The readiness poll ran out of budget — and nothing else. Every OTHER
 * failure {@link pollForBinding} meets is rethrown as itself, so this class
 * is an exact answer to "was it the clock?", which a caller that has to
 * choose between two timeout messages needs and cannot get from the clock.
 *
 * Reading `remainingMs()` after the fact is NOT that answer: the expiry timer
 * and `performance.now()` are different clocks, and a timer that fires a
 * fraction of a millisecond early leaves a positive remainder behind an
 * expiry that has already happened.
 */
export class ReadinessPollTimeout extends Error {
	override readonly name = 'ReadinessPollTimeout'
}

/**
 * What a failed readiness read is worth, decided by the caller.
 *
 * Optional, and absent means exactly the behaviour every caller had before:
 * the first failure of any kind ends the poll. `workspace.ts` passes nothing
 * and is unchanged; the acquire path passes
 * {@link retryDelayForApiFailure} so one 429 on a shared cluster no longer
 * fails a create that had fifty-nine seconds of budget left.
 */
export interface ReadinessPollBehaviour {
	/**
	 * Milliseconds to wait before reading again, or `undefined` to rethrow.
	 *
	 * The wait is spent on the SAME deadline as everything else in the poll,
	 * so a retry consumes the readiness budget and can never extend it. A hook
	 * that always returns a number therefore still terminates: the clock ends
	 * the loop, not the hook.
	 */
	readonly retryDelayFor?: (err: unknown) => number | undefined
}

/**
 * Poll until `read` reports a binding. `read` returns `undefined` for "not
 * yet" and throws for a failure worth surfacing; the deadline owns every wait,
 * including the sleep between attempts, so an expired clock cannot be extended
 * by one more round trip. Shaped after ACI's `pollForRunningIp`.
 *
 * The only failure this raises on its own account is
 * {@link ReadinessPollTimeout}; anything `read` throws travels out unchanged,
 * unless `behaviour.retryDelayFor` claims it — in which case it is repeated
 * inside the same budget and, if the budget then runs out, carried onto the
 * timeout as its `cause`, so a poll that kept failing still says what it kept
 * seeing.
 */
export async function pollForBinding(
	read: (signal: AbortSignal) => Promise<KubernetesSandboxBinding | undefined>,
	deadline: OperationDeadline,
	readiness: { readonly timeoutMs: number; readonly pollIntervalMs: number },
	label: string,
	behaviour: ReadinessPollBehaviour = {},
): Promise<KubernetesSandboxBinding> {
	/**
	 * The last failure that was retried rather than raised, and only while it
	 * is still the truth: a read that succeeds clears it, so the timeout
	 * carries a failure the poll was STILL meeting when the budget ran out
	 * rather than a blip it recovered from twenty polls earlier. The
	 * difference is not cosmetic — the acquire's reason is read off this
	 * cause, so a stale one would report an API outage for a poll whose API
	 * was answering fine.
	 */
	let lastRetried: unknown
	while (deadline.remainingMs() > 0) {
		/** Overrides the poll cadence for one round when the server named one. */
		let nextDelayMs = readiness.pollIntervalMs
		try {
			const binding = await deadline.run(read)
			lastRetried = undefined
			if (binding) return binding
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			const retryDelayMs = behaviour.retryDelayFor?.(err)
			if (retryDelayMs === undefined) throw err
			lastRetried = err
			nextDelayMs = retryDelayMs
		}
		try {
			await deadline.delay(nextDelayMs)
		} catch (err) {
			if (err instanceof OperationDeadlineExpired) break
			throw err
		}
	}
	throw new ReadinessPollTimeout(
		`kubernetes: ${label} never became Ready (${readiness.timeoutMs}ms)${
			lastRetried !== undefined
				? `; the last API failure retried inside that budget was: ${
						lastRetried instanceof Error ? lastRetried.message : String(lastRetried)
					}`
				: ''
		}`,
		lastRetried !== undefined ? { cause: lastRetried } : undefined,
	)
}

/**
 * The live pod behind a bound sandbox: its uid, and — read in the SAME
 * answer — the IP it can be dialed at.
 *
 * One record rather than two reads because the two facts have to describe one
 * pod. The uid is the agent's bind token and the IP is where that agent
 * listens; taking them from separate GETs leaves a window in which a resume,
 * an eviction or a node drain replaces the pod in between, and the handle
 * then presents pod A's token at pod B's address. The guest answers that with
 * a flat `unauthorized`, which says nothing about the race that caused it.
 */
export interface KubernetesBoundPod {
	/** `metadata.uid` — the agent's bind token. */
	readonly uid: string
	/** `status.podIP`. Read by `agentAddress: 'pod-ip'`; absent is legal. */
	readonly podIP?: string
	/**
	 * `metadata.labels` — what an ingress policy's `podSelector` actually
	 * matches. Read off the SAME object the uid and the address come from,
	 * for the same reason they are: a policy decision made about one pod and
	 * a connection made to another is the mismatch this record exists to
	 * prevent. The claim path reads it to ask which policies select the bound
	 * pod — a directly created Sandbox's labels are known before its pod
	 * exists — and BOTH paths read it to confirm the pod really carries the
	 * labels this backend asked the controller for, which is the one thing
	 * knowing them in advance cannot establish. See `ingress-policy.ts` and
	 * `assertRequestedPodLabelsObserved`.
	 */
	readonly labels?: Readonly<Record<string, string>>
}

/**
 * Find the pod a sandbox is currently backed by, and read both facts off it.
 *
 * `uid` is the per-instance agent bind token; `podIP` is where that agent
 * listens, and only `agentAddress: 'pod-ip'` reads it.
 *
 * The pod is named after its Sandbox in agent-sandbox v1.0.2 — verified
 * against a running cluster — but that is an observation, not a documented
 * guarantee, and `Sandbox.status` exposes no pod name to fall back on. So the
 * fast path is one GET by that name, and the only cost of the name convention
 * changing upstream is a second round trip through `status.selector`, which is
 * exactly what the controller publishes the selector for.
 */
export async function readBoundPod(
	client: KubernetesClient,
	namespace: string,
	binding: KubernetesSandboxBinding,
	signal?: AbortSignal,
): Promise<KubernetesBoundPod> {
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
		if (uid && isPodLive(pod)) return boundPod(uid, pod)
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
			if (uid && isPodLive(pod)) return boundPod(uid, pod)
		}
	}
	throw new Error(
		`kubernetes: could not read a pod uid for sandbox ${binding.name} in namespace ${namespace} — no live pod of that name, and its status.selector matched no live pod either (a pod carrying a deletionTimestamp, or in phase Succeeded/Failed, is never bound to). The pod uid is the agent's bind token, so the sandbox is refused rather than returned unauthenticated.`,
	)
}

function boundPod(uid: string, pod: PodResource): KubernetesBoundPod {
	const podIP = readPodIP(pod)
	const labels = pod.metadata?.labels
	return {
		uid,
		...(podIP !== undefined ? { podIP } : {}),
		...(labels !== undefined ? { labels } : {}),
	}
}

/**
 * {@link readBoundPod}, plus — under `'pod-ip'` only — the wait for an
 * address to go with the token.
 *
 * Under the default mode this is the single read it has always been: one
 * `GET`, in the same place in the same order, because a Service FQDN is
 * published with the Sandbox and needs nothing from the pod but its uid.
 *
 * `'pod-ip'` has to wait, because a LIVE pod is not yet an ADDRESSED pod. A
 * pod is created `Pending` and carries no `status.podIP` until the CNI has
 * finished attaching it, and {@link isPodLive} accepts `Pending` on purpose —
 * the resume path in `workspace.ts` binds its replacement pod long before that
 * pod is Ready, because `Ready` stays True across the transition and the uid
 * is the only transition signal there is. Refusing an address-less pod outright
 * would therefore fail on the NORMAL path, in milliseconds, with the whole
 * readiness budget unspent. So "live, no address yet" is polled on the same
 * deadline as everything else on this path, and
 * {@link resolveAgentAddress}'s own refusal is left as the post-deadline
 * backstop for a pod that never gets an address at all.
 *
 * A failed READ stays fatal, exactly as it was: this is the acquire path,
 * where nothing is being replaced and a pod that cannot be read is not a pod
 * that is about to appear.
 *
 * `requiredLabels` is the second thing worth waiting for, and it is waited
 * for in the SAME loop rather than in a second one: an egress profile is a
 * label the CONTROLLER patches onto the pod it binds, so a pod read the
 * instant it was bound can be live, addressed and not yet labelled. Two
 * loops would be two deadlines and two answers to "is this pod ready to be
 * admitted". Like the address, an expired clock hands the pod back as it is
 * — the caller decides whether a missing label is fatal, and on the acquire
 * path it is: see `assertRequestedPodLabelsObserved`.
 */
export async function readAddressedPod(
	client: KubernetesClient,
	namespace: string,
	binding: KubernetesSandboxBinding,
	deadline: OperationDeadline,
	readiness: { readonly pollIntervalMs: number },
	mode: KubernetesAgentAddressMode,
	requiredLabels?: Readonly<Record<string, string>>,
): Promise<KubernetesBoundPod> {
	const required = Object.entries(requiredLabels ?? {})
	const wanting = (pod: KubernetesBoundPod): boolean =>
		(mode === 'pod-ip' && pod.podIP === undefined) ||
		required.some(([key, value]) => pod.labels?.[key] !== value)

	let pod = await deadline.run((signal) => readBoundPod(client, namespace, binding, signal))
	while (wanting(pod) && deadline.remainingMs() > 0) {
		try {
			await deadline.delay(readiness.pollIntervalMs)
			pod = await deadline.run((signal) => readBoundPod(client, namespace, binding, signal))
		} catch (err) {
			// An expired clock hands the incomplete pod back rather than
			// replacing it with a bare "deadline expired": the caller's
			// `resolveAgentAddress` (or `assertRequestedPodLabelsObserved`) then
			// reports WHICH fact never arrived.
			if (err instanceof OperationDeadlineExpired) break
			throw err
		}
	}
	return pod
}

/**
 * The re-read a `'pod-ip'` handle follows a replaced pod with: one live-pod
 * read, then the same address resolution acquire did.
 *
 * Built here rather than inside the transport because finding the pod is a
 * CONTROL-plane act — the by-name GET, the selector fallback, the
 * liveness filter — and the transport owns none of that. It is handed over as
 * a closure so the transport can call it without learning what a Sandbox is.
 */
export function buildAgentAddressRefresh(
	client: KubernetesClient,
	namespace: string,
	binding: KubernetesSandboxBinding,
	agentPort: number,
	mode: KubernetesAgentAddressMode,
): (signal?: AbortSignal) => Promise<KubernetesAgentAddress> {
	return async (signal) => {
		const pod = await readBoundPod(client, namespace, binding, signal)
		return resolveAgentAddress(binding, agentPort, pod.uid, {
			mode,
			...(pod.podIP !== undefined ? { podIP: pod.podIP } : {}),
		})
	}
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
	/**
	 * Present exactly when `config.egress.perSandbox` is configured — which
	 * is what makes `setNetworkPolicy` present on the handle. See
	 * `per-sandbox-policy.ts`.
	 */
	setNetworkPolicy?: (policy: SandboxNetworkPolicy) => Promise<void>,
): Promise<Sandbox> {
	const sandbox = buildKubernetesSandbox({
		name: acquisition.binding.name,
		rootDir: options.workingDirectory,
		transport: new KubernetesAgentTransport(acquisition.agent, {
			// The backend opts in to the stream heartbeat; the transport
			// option it sets stays undefined for every other tier.
			heartbeatMs: resolveStreamHeartbeatMs(config.streamHeartbeatMs),
			...(acquisition.refreshAgent !== undefined
				? { refreshHandle: acquisition.refreshAgent }
				: {}),
		}),
		release: acquisition.release,
		renew: acquisition.renew,
		ttlSeconds: acquisition.ttlSeconds,
		...(config.onLeaseRenewalError !== undefined
			? { onRenewalError: config.onLeaseRenewalError }
			: {}),
		...(setNetworkPolicy !== undefined ? { setNetworkPolicy } : {}),
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
