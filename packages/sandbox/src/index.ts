/**
 * @namzu/sandbox — pluggable containment for @namzu/sdk.
 *
 * The SDK declares the `SandboxProvider` shape
 * (`packages/sdk/src/types/sandbox/index.ts`); this package implements
 * it with concrete BACKENDS chosen at construction time. A backend is
 * named for the mechanism it drives, because that is what it has to
 * speak on the wire — never for a system whose ideas it borrowed.
 *
 * Two tiers, each a trust boundary:
 *
 *  • `container` — one OCI container per task, seccomp on, tmpfs
 *    workdir, no network unless asked. The same path on a laptop and
 *    on a Linux replica anywhere. The tier for trusted prompts and
 *    contained workloads. Boundary: kernel namespaces, or a
 *    userspace-kernel runtime where one is installed.
 *
 *  • `microvm` — one hardware-virtualized guest per task. The boundary
 *    to reach for when the prompt itself is adversarial, at the cost
 *    of running or renting the machinery that starts them.
 *
 * Every shape in {@link SandboxBackendConfig} has a backend behind it,
 * which used not to be true: a `process` tier, a `passthrough` tier and
 * two adapters to third-party schedulers were declared here and never
 * written, so four of the shapes this package offered could only ever
 * type-check and then throw. They are gone rather than pending.
 * Confining an agent to the operator's own host is the SDK's local
 * sandbox provider, which is implemented; a host that wants no
 * confinement configures no sandbox.
 *
 * namzu does not build its own microVM scheduler. That is a years-long
 * detour from an agent kernel, and the boundary a guest gives is the
 * same whoever started it — so the microvm tier is an interface to a
 * scheduler, not a scheduler.
 */

import type {
	ContainerSandboxLayout,
	Sandbox,
	SandboxCreateConfig,
	SandboxProvider,
} from '@namzu/sdk'

import { buildAciStandbyPoolBackend } from './backends/aci-standby-pool/index.js'
import { buildDockerBackend, resolveLayout } from './backends/docker/index.js'
import { buildFirecrackerBackend } from './backends/firecracker/index.js'
import type { KubernetesEgressConfig } from './backends/kubernetes/egress-policy.js'
import {
	type KubernetesAgentAddressMode,
	type KubernetesBackendInternalConfig,
	type KubernetesClusterAccess,
	buildKubernetesBackend,
} from './backends/kubernetes/index.js'
import {
	type KubernetesWorkspace,
	type KubernetesWorkspaceOptions,
	type KubernetesWorkspaceSummary,
	type KubernetesWorkspaceTransitionOptions,
	createKubernetesWorkspace as buildKubernetesWorkspace,
	deleteKubernetesWorkspace as deleteWorkspaceOnCluster,
	listKubernetesWorkspaces as listWorkspacesOnCluster,
	suspendKubernetesWorkspace as suspendWorkspaceOnCluster,
} from './backends/kubernetes/workspace.js'

// Re-export the layout types so consumers of `@namzu/sandbox` can
// import them without also depending on `@namzu/sdk`. The canonical
// home of the types is the SDK; this is a convenience pass-through.
export type {
	ContainerSandboxLayout,
	ContainerSandboxLayoutMount,
	ContainerSandboxMountSource,
	ContainerSandboxSkillMount,
	ResolvedContainerSandboxLayout,
} from '@namzu/sdk'

// Re-export the default container-path constants the prompt-template
// generator side wants to import without also depending on
// `@namzu/sdk` directly. Single source of truth: a Vandal prompt
// saying "write outputs to `/mnt/user-data/outputs`" imports
// `SANDBOX_DEFAULT_OUTPUTS_PATH` instead of hard-coding the string.
export {
	SANDBOX_DEFAULT_OUTPUTS_PATH,
	SANDBOX_DEFAULT_SKILLS_PARENT,
	SANDBOX_DEFAULT_TOOL_RESULTS_PATH,
	SANDBOX_DEFAULT_TRANSCRIPTS_PATH,
	SANDBOX_DEFAULT_UPLOADS_PATH,
} from '@namzu/sdk'

// Firecracker (owned Azure platform) public surface. The Vandal-side
// `firecracker-lifecycle.ts` imports the agent-handle shape + the
// transport so it can mint the orchestrator handle and run the vsock
// heartbeat probe without reaching into `backends/`.
export type {
	FirecrackerBackendInternalConfig,
	OrchestratorTokenProvider,
} from './backends/firecracker/index.js'
export {
	AgentDialFailedError,
	AgentPreauthFrameTooLargeError,
	AgentWriteFileTooLargeError,
	DEFAULT_MAX_WRITE_FILE_BYTES,
	FIRECRACKER_AGENT_PROTOCOL_VERSION,
	GUEST_FRAME_LIMIT_BYTES,
	type SandboxAgentHandle,
	TCP_PREAUTH_FRAME_LIMIT_BYTES,
	type VsockTransportOptions,
	VsockAgentTransport,
} from './backends/firecracker/transport.js'
// The `write-file` part protocol: the healthz feature string a guest
// advertises when it can take a body larger than one frame, and the shape
// of one part. Exported so a host writing its own guest, or asserting what
// this one advertises, names them rather than repeating the literal.
export {
	WRITE_FILE_PARTS_FEATURE,
	type WriteFilePart,
} from './backends/firecracker/protocol.js'

// Kubernetes (agent-sandbox on any cluster) public surface. The access union
// is named by `KubernetesBackendConfig.access`, so a host that builds its own
// credential callback can name what it is passing; the address mode is named
// by `KubernetesBackendConfig.agentAddress` and decides whether the agent is
// dialed at its Service FQDN (in-cluster host) or at its pod IP (a host
// outside the cluster, on a routable pod network).
export type {
	KubernetesAgentAddressMode,
	KubernetesClusterAccess,
} from './backends/kubernetes/index.js'
// Egress translation types named by `KubernetesBackendConfig.egress` — see
// `backends/kubernetes/egress-policy.ts` for what each engine can express.
export type {
	KubernetesEgressConfig,
	KubernetesEgressEngine,
} from './backends/kubernetes/egress-policy.js'
// The errors a caller of a kubernetes sandbox has to be able to catch BY
// CLASS rather than by matching a message: an acquire refused because the
// guest is not deprivileged, a call after the handle ended (this host
// destroyed it, or the cluster deleted it), and a rejected agent token.
export {
	KubernetesPrivilegeProbeError,
	type PrivilegeProbeFailure,
	type ProcStatusPrivileges,
} from './backends/kubernetes/privilege-probe.js'
export {
	KubernetesSandboxDestroyedError,
	KubernetesSandboxGoneError,
} from './backends/kubernetes/sandbox.js'
export {
	KubernetesAgentAddressUnresolvableError,
	KubernetesAgentUnauthorizedError,
} from './backends/kubernetes/transport.js'
// The persistent workspace: a `Sandbox` that keeps a block disk across a
// suspend, the union naming how a handle came by its object, plus the four
// errors its lifecycle can refuse with — a template that cannot carry a disk,
// a standing object that does not match this configuration, a call on a
// suspended workspace, and a suspend whose pod outlived the wait. Declared in
// `@namzu/sandbox` rather than on the SDK's `Sandbox` — see
// `backends/kubernetes/workspace.ts`.
export type {
	KubernetesWorkspace,
	KubernetesWorkspaceDestroyOptions,
	KubernetesWorkspaceOptions,
	KubernetesWorkspaceOrigin,
	KubernetesWorkspaceSummary,
	KubernetesWorkspaceSuspensionNotice,
	KubernetesWorkspaceTransitionOptions,
} from './backends/kubernetes/workspace.js'
export {
	KubernetesWorkspaceDiskError,
	KubernetesWorkspaceMismatchError,
	KubernetesWorkspaceSuspendTimeoutError,
	KubernetesWorkspaceSuspendedError,
} from './backends/kubernetes/workspace.js'

// ---------------------------------------------------------------------------
// Backend strategy
// ---------------------------------------------------------------------------

/**
 * Top-level sandbox tier, and the trust boundary it buys:
 *
 *   - `container` — one OCI container per task. Namespaces. The
 *     default for trusted prompts and contained workloads, and the
 *     same code path on a laptop and on a Linux replica anywhere.
 *
 *   - `microvm` — one hardware-virtualized guest per task. The
 *     boundary to reach for when the prompt itself is adversarial.
 *
 * Two tiers, not four. A `process` tier and a `passthrough` tier were
 * declared here and never built: every construction threw, so the
 * only thing they offered a caller was a shape that compiles and an
 * exception at runtime. Confining the agent to the operator's own
 * host is the SDK's local sandbox provider, which is implemented; a
 * host that wants no confinement configures no sandbox.
 *
 * The concrete implementation inside a tier is picked via the
 * tier-specific config (see {@link ContainerBackendConfig},
 * {@link MicroVMBackendConfig}).
 */
export type SandboxTier = 'container' | 'microvm'

/**
 * Discriminated union of sandbox backend configurations. Each
 * tier has its own configuration shape — picking a tier picks the
 * shape automatically via TS narrowing.
 */
export type SandboxBackendConfig =
	| ContainerBackendConfig
	| ACIStandbyPoolBackendConfig
	| MicroVMBackendConfig
	| KubernetesBackendConfig

/**
 * Azure Container Instances Standby Pool backend. Container tier,
 * managed-microvm-ish: every claim is a fresh ACI container group
 * pre-warmed in an Azure-managed standby pool (`Microsoft.StandbyPool`).
 * ~1.5 s claim latency vs ~10-30 s for cold ACI spawn. Trust boundary
 * = the provider's isolation host, whose strength varies by SKU; the
 * Confidential SKU adds an AMD SEV-SNP trusted execution environment.
 *
 * No host filesystem — workspace mounts ride `azureFileShare` sources
 * (the host provisions a per-task Azure Files share upstream and
 * threads it into the layout). Auth via a caller-supplied
 * `getArmToken()` callback so the sandbox package stays free of
 * Azure SDK dependencies; the host runtime owns Managed Identity /
 * AzureCLI / federated credential picking.
 *
 * Use this when (a) running on Azure Container Apps and you cannot
 * mount the docker socket, (b) you want per-task container
 * isolation without operating a Firecracker host yourself, and
 * (c) sub-2-second claim latency is acceptable.
 */
export interface ACIStandbyPoolBackendConfig {
	readonly tier: 'container'
	readonly runtime: 'aci-standby-pool'
	readonly subscriptionId: string
	readonly resourceGroup: string
	readonly location: string
	readonly standbyPoolResourceId: string
	readonly containerGroupProfileResourceId: string
	readonly containerGroupProfileRevision?: number
	/**
	 * Async callback returning a fresh ARM bearer token (audience
	 * `https://management.azure.com/`). Invoked on every ARM call.
	 */
	readonly getArmToken: () => Promise<string>
	readonly subnetId?: string
	/** Delay between IP / health probes. Default 500ms. */
	readonly readyPollIntervalMs?: number
	/** Total deadline across IP publication and worker health. Default 60000ms. */
	readonly readyTimeoutMs?: number
	readonly workerPort?: number
	readonly armApiVersion?: string
	/**
	 * Prefix for the ACI container group name and the inner worker
	 * container. Combined with a generated sandbox id and
	 * sanitised to ARM's allowed character set. Default
	 * `namzu-task`; consumers (e.g. Vandal) override to brand
	 * their own deployments.
	 */
	readonly containerNamePrefix?: string
}

/**
 * `container` tier. Two runtime options:
 *
 *   - `docker` (default) — plain OCI container on the host's
 *     Docker daemon. No special runtime required.
 *   - `runsc` — a userspace-kernel runtime: the guest's syscalls
 *     are served by a user-space implementation rather than the
 *     host kernel, which is a stronger boundary than namespaces and
 *     runs on commodity Linux without nested virtualization.
 *     Requires the runtime installed on the container daemon (Linux
 *     only).
 *
 * `image` is the container image to spawn per task. The package
 * ships a reference Dockerfile (compass-platform pattern) with
 * Python doc-gen libraries, LibreOffice, pandoc, Chromium, and
 * `tesseract` pre-installed; hosts that want a leaner image
 * supply their own.
 */
export interface ContainerBackendConfig {
	readonly tier: 'container'
	readonly runtime?: 'docker' | 'runsc'
	readonly image: string
	/**
	 * How the SDK consumer reaches the in-container worker. Default
	 * `'host-port'` — the original loopback host-port flow, works
	 * when the consumer runs ON the docker host. Set
	 * `'container-network'` when the consumer is itself a container
	 * spawning siblings via the host's Docker daemon: the worker is
	 * reachable at `http://<containerName>:2024` over the docker
	 * bridge named in `network`.
	 */
	readonly hostReachability?: 'host-port' | 'container-network'
	/**
	 * Docker network the spawned container attaches to. Default
	 * `'none'` (no inbound or outbound network).
	 *
	 * **The default does not work with the default `hostReachability`,
	 * and `create()` refuses rather than starting a container nobody can
	 * reach.** Docker binds a published port to the container's address,
	 * so a container with no route out has no address to bind to and
	 * nothing is published. Name a bridge here to reach the worker by host
	 * port, or set `hostReachability: 'container-network'` and reach it by
	 * container name — that mode works on an `--internal` network, which
	 * is also the only way to get `deny-all` enforced.
	 *
	 * Egress from the sandbox is governed separately by `EgressPolicy`,
	 * which is checked against this network rather than trusted.
	 */
	readonly network?: 'none' | 'bridge' | string
	/**
	 * Maximum time spent waiting for the container worker's `/healthz`
	 * readiness probe. Must be a positive integer within Node's timer range.
	 * Default 30000ms.
	 */
	readonly readyTimeoutMs?: number
	/**
	 * Delay between worker readiness probes. Must be a positive integer within
	 * Node's timer range; the final delay is capped by `readyTimeoutMs`.
	 * Default 100ms.
	 */
	readonly readyPollIntervalMs?: number
	/**
	 * Allowlisted hosts permitted to resolve to an inward address anyway.
	 *
	 * The egress boundary refuses a host that resolves to loopback, a
	 * private range, or the link-local block cloud metadata services answer
	 * on — whatever the allowlist says, because an allowlisted name whose
	 * DNS someone else controls is a permitted spelling rather than a
	 * permitted destination. A deployment that genuinely proxies to one
	 * service on a private network names that service here.
	 *
	 * Per host, matched by the allowlist's own rules so `.internal.example`
	 * covers subdomains. There is deliberately no switch that turns the
	 * screen off: one would hand every other allowlisted name the same
	 * reach, which is the hole the screen exists to close.
	 */
	readonly allowInwardFor?: readonly string[]
	/**
	 * Optional `--label key=value` pairs applied to the spawned
	 * container. Hosts use this to make the container findable from
	 * out-of-band cleanup paths (reaper jobs, monitoring filters)
	 * via `docker ps --filter label=...`. Keys with `=` or empty
	 * names are rejected at construction; values are passed verbatim
	 * to the docker CLI argv (no shell interpolation — `spawn` argv
	 * not a shell pipeline). Default unset (no extra labels).
	 *
	 * Convention for namzu hosts: namespace your keys
	 * (`vandal.sandbox=true`, `vandal.task-id=<id>`, …) to avoid
	 * collisions with Docker / orchestrator labels.
	 */
	readonly labels?: Readonly<Record<string, string>>
}

/**
 * `microvm` tier, against namzu's own guest orchestrator.
 *
 * Two adapters to third-party managed schedulers were declared here
 * and never written: both threw on construction, and each demanded
 * required credentials for a call that was never made. A config
 * shape whose only reachable outcome is an exception is worse than
 * no shape, because it type-checks.
 *
 * What remains is the orchestrator namzu runs: the control plane
 * mints a guest per task and resumes it copy-on-write from a golden
 * snapshot, so a cold start is a resume rather than a boot.
 */
export type MicroVMBackendConfig = {
	readonly tier: 'microvm'
	readonly service: 'self-hosted'
	/**
	 * Control-plane base URL, and the bearer minted for it.
	 *
	 * Both are REQUIRED, which is a correction: they were optional
	 * beside three required fields (`firecrackerBinary`,
	 * `kernelImage`, `rootfsImage`) belonging to a local-daemon shape
	 * that was never implemented. So the only working configuration
	 * had to supply three values nothing reads, and omitting these
	 * two type-checked its way to a runtime throw.
	 *
	 * `getToken` is a closure rather than a credential, so this
	 * package carries no cloud SDK: the host runtime owns how the
	 * bearer is obtained.
	 */
	readonly orchestratorEndpoint: string
	readonly getToken: () => Promise<string>
	/** Golden snapshot revision to resume copy-on-write. */
	readonly template?: string
	/**
	 * Resume this per-agent captured snapshot (layered on its base
	 * golden) INSTEAD of a fresh golden boot. Tier-agnostic, additive,
	 * optional: the backend that supports it (the owned firecracker
	 * backend) honors it; others ignore it. Absent ⇒ the create body is
	 * byte-identical and the generic golden-resume hot path is unchanged
	 * (the field is only ever set by the host's per-agent trigger path).
	 * Sibling to `template` (base-golden selector) — see
	 * {@link AgentSnapshotRef}.
	 */
	readonly agentSnapshot?: AgentSnapshotRef
	/** Fixed guest AF_VSOCK port the in-VM agent listens on. */
	readonly agentVsockPort?: number
	/** Total guest-agent health deadline after the orchestrator claim. Default 60000ms. */
	readonly readyTimeoutMs?: number
	/** Delay between guest-agent health probes. Default 250ms. */
	readonly readyPollIntervalMs?: number
	/**
	 * NETWORK-mode mTLS client material (ses_051 P4 client-proxy
	 * bridge). When present, the orchestrator returns an `mtls` agent
	 * handle (host/port/sandboxId, NO cert material) and this CA/cert/key
	 * is MERGED onto that handle before the transport dials the per-host
	 * relay over mTLS. Injected by the consumer's runtime (the Vandal
	 * host layer reads it from `VANDAL_SANDBOX_FC_TLS_*`), NEVER fetched
	 * inside this package — same dependency boundary as `getToken`, so
	 * `@namzu/sandbox` stays Azure-SDK-free. Absent for the single-host
	 * VSOCK default (the live proofs).
	 */
	readonly mtls?: {
		readonly ca: string | Buffer
		readonly cert: string | Buffer
		readonly key: string | Buffer
		readonly servername?: string
	}
	/**
	 * CONTROL-plane mTLS client material. When present, the orchestrator
	 * control-plane calls (create/destroy POSTs to `orchestratorEndpoint`)
	 * dial over mTLS — presenting this client cert and pinning this CA —
	 * instead of plain `fetch`. Secures the control plane when
	 * `orchestratorEndpoint` is an `https://` URL reached over the PUBLIC
	 * internet (the non-VNet-integrated caller→FC-host hop), where the
	 * shared-secret bearer alone would be exposed. The bearer is STILL sent
	 * (defense in depth). Same `{ca,cert,key,servername}` shape + the same
	 * consumer-injected dependency boundary as `mtls` (the one fleet CA
	 * secures both planes). Absent → plain `fetch` control plane (the
	 * single-host VSOCK default, unchanged).
	 */
	readonly controlPlaneMtls?: {
		readonly ca: string | Buffer
		readonly cert: string | Buffer
		readonly key: string | Buffer
		readonly servername?: string
	}
}

/**
 * A reference to a per-agent captured snapshot, layered on top of a base
 * golden revision. Provider-AGNOSTIC: this is a sandbox-spec concept, a
 * sibling to {@link MicroVMBackendConfig}'s `template` (which selects a
 * base golden), not a provider-specific shape — hence no provider prefix
 * in the name. A microVM backend that supports per-agent resume (the owned
 * Firecracker backend) honors it by resuming this agent's captured diff
 * INSTEAD of a fresh golden boot; backends that do not support it ignore it.
 *
 * The triple identifies exactly one captured snapshot: the owning tenant
 * (`orgId`), the agent registry row (`agentId`), and the registry version
 * (`version`, a decimal string so the whole triple is a set of path
 * segments). The host constructs this server-side from its own registry;
 * `@namzu/sandbox` only forwards it.
 */
export interface AgentSnapshotRef {
	readonly orgId: string
	readonly agentId: string
	readonly version: string
}

/**
 * `microvm` tier, against a Kubernetes cluster running the agent-sandbox
 * controller (kubernetes-sigs/agent-sandbox) with a VM-isolating
 * RuntimeClass such as Kata.
 *
 * `microvm` because the tier names the strength of the boundary rather than
 * the orchestrator behind it: a pod scheduled onto a Kata RuntimeClass runs
 * in a hardware-virtualized guest, and the same field on the same tier is how
 * a host says "give me a VM, I do not care who starts it".
 *
 * Sandboxes are claimed out of a `SandboxWarmPool` when {@link warmPoolName}
 * names one, which is what makes the acquire sub-second; without it every
 * create is a `Sandbox` built from {@link sandboxTemplateName}'s podTemplate
 * and pays a full pod start. This package speaks the API server with bare
 * `fetch` and carries no Kubernetes client dependency: credentials arrive
 * through {@link access}, and kubeconfig parsing (context merging,
 * exec credential plugins) stays in the host that owns it.
 */
export interface KubernetesBackendConfig {
	readonly tier: 'microvm'
	readonly service: 'kubernetes'
	/** Namespace the claims, sandboxes and their pods live in. */
	readonly namespace: string
	/**
	 * How to reach the API server. `{ inCluster: true }` reads the projected
	 * ServiceAccount volume and the kubelet's `KUBERNETES_SERVICE_*` env, which
	 * is the production path; otherwise the host supplies the server URL, an
	 * optional cluster CA and a `getToken()` callback — the same boundary this
	 * package already draws for ACI's `getArmToken` and Firecracker's
	 * `getToken`.
	 */
	readonly access: KubernetesClusterAccess
	/**
	 * `SandboxTemplate` whose `podTemplate` a POOL-LESS create copies into the
	 * `Sandbox` it posts. Required because `Sandbox.spec` has no `templateRef`
	 * — only a `SandboxWarmPool` references a template — so the pod spec has to
	 * be carried across by the client. The warm path does not read it; the
	 * pool's own `sandboxTemplateRef` decides there.
	 */
	readonly sandboxTemplateName: string
	/**
	 * `SandboxWarmPool` to claim from. Absent → every create posts a `Sandbox`
	 * directly, because `SandboxClaim.spec.warmPoolRef` is a required field and
	 * a pool-less claim does not exist in the API.
	 */
	readonly warmPoolName?: string
	/** TCP port the in-pod guest agent listens on. Default 1024. */
	readonly agentPort?: number
	/**
	 * Which of a sandbox's two addresses the transport dials.
	 *
	 * `'service'` (default) is the Sandbox's `status.serviceFQDN`, which
	 * outlives the pod and is re-resolved on every dial — and which ONLY the
	 * cluster's own DNS answers. A host running outside the cluster fails
	 * every call at name resolution, readiness included, so it reads as a
	 * sandbox that never came up.
	 *
	 * `'pod-ip'` dials the bound pod's IP, read from the same `GET` that
	 * reads its bind token. For a host outside the cluster with a route to
	 * the pod network. It needs that route and a `NetworkPolicy` admitting
	 * the host's address range on {@link agentPort}; the IP dies with its
	 * pod, which the backend covers by re-reading it on every resume and once
	 * after a connect failure. Nothing else changes: same bind token, same
	 * privilege probe, same egress verification.
	 */
	readonly agentAddress?: KubernetesAgentAddressMode
	/** Delay between readiness polls. Default 50ms. */
	readonly readyPollIntervalMs?: number
	/** Total deadline from create to an addressed, Ready sandbox. Default 60000ms. */
	readonly readyTimeoutMs?: number
	/**
	 * Wall-clock lifetime written into every object this backend creates, so a
	 * host that dies mid-run costs the cluster one expiry rather than a leaked
	 * sandbox. Default 3600.
	 */
	readonly claimTtlSeconds?: number
	/**
	 * Every lease-renewal failure that is not "the object is already gone".
	 *
	 * The handle renews its own `shutdownTime` every half-TTL for as long as
	 * it is alive, so a run that outlives `claimTtlSeconds` keeps its pod.
	 * A failed renewal is retried on a short capped backoff — starting at one
	 * second, not the next half-TTL tick — so a single API blip near a
	 * scheduled renewal gets several more chances before anything expires;
	 * this callback is where the diagnostic goes, because `@namzu/sandbox`
	 * owns no logger and reads none from module scope. Setting it changes
	 * nothing about behaviour.
	 */
	readonly onLeaseRenewalError?: (error: unknown) => void
	/**
	 * RuntimeClass for a POOL-LESS create. Refused together with
	 * {@link warmPoolName}: a pooled sandbox is already running under the
	 * RuntimeClass its `SandboxTemplate` named, and a claim cannot change it —
	 * so accepting it there would quietly drop the choice of VM boundary.
	 */
	readonly runtimeClassName?: string
	/**
	 * Egress policy this backend expects an operator to have applied as a
	 * `NetworkPolicy` (or, under `engine: 'cilium'`, a `CiliumNetworkPolicy`)
	 * scoped to every Sandbox this backend produces. Unset means this backend
	 * neither computes nor checks one — the cluster's default posture (the
	 * `SandboxTemplate`'s own managed `NetworkPolicy`) is all that applies.
	 *
	 * This is a CONFIG-level, whole-backend policy, not a per-`create()` one:
	 * `SandboxBackendOptions.egress` is still refused by name (see
	 * `backends/kubernetes/index.ts`'s `assertEnforceable`), because the
	 * enforcement point is one object attached to the template and cannot be
	 * rewritten per running sandbox. `static` and `resolver` — hostname
	 * allowlists — throw a named error at construction unless `engine` is
	 * `'cilium'`: core `NetworkPolicy` has no FQDN concept at all. See
	 * `docs/sdk/kubernetes-sandbox.md`'s egress section.
	 */
	readonly egress?: KubernetesEgressConfig
}

/**
 * Egress allowlist resolution. Host-supplied policy decides whether
 * an outbound request is allowed before the proxy opens a socket.
 *
 * Four shapes:
 *
 *   - `deny-all` — default. Reject every outbound request.
 *   - `allow-all` — accept every outbound request. Tests only.
 *   - `static` — fixed allowlist of hostnames at construction.
 *   - `resolver` — async closure returning the allowlist.
 *     Parameterless **on purpose**: the resolver is a closure that
 *     captures whatever context the host has (tenantId, runId,
 *     auth token, etc.) at provider-construction time. Compass-
 *     platform's JWT-minting flow already works this way: the
 *     server knows the tenant when it issues the JWT, and the
 *     allowlist claim is baked in there. This avoids the
 *     "where does the resolver get its context from" plumbing
 *     problem — the host owns the closure, the SDK runtime
 *     doesn't have to forward identity through `provider.create`.
 */
export {
	EgressProxy,
	isHostAllowed,
	splitAuthority,
} from './egress/index.js'
export type {
	BrokeredCredential,
	EgressProxyOptions,
	RunningEgressProxy,
} from './egress/index.js'

export type EgressPolicy =
	| { readonly kind: 'deny-all' }
	| { readonly kind: 'allow-all' }
	| { readonly kind: 'static'; readonly allowedHosts: readonly string[] }
	| { readonly kind: 'resolver'; readonly resolve: () => Promise<readonly string[]> }

/**
 * Backend strategy. Each tier × concrete-service combination ships
 * an implementation of this interface in its own subfolder under
 * `src/backends/`.
 *
 * Backends are responsible for:
 *  - turning {@link SandboxBackendOptions} into a concrete
 *    {@link Sandbox} instance the SDK can use,
 *  - wiring {@link EgressPolicy} into whatever proxy / network
 *    primitive the backend has,
 *  - cleaning up host resources on `destroy()` (process-level
 *    cleanup, container teardown, microVM stop+delete, etc.).
 *
 * Tier-specific concepts (bind-mount layout for container, microVM
 * volume id, process-tier seccomp profile) are NOT carried on
 * `SandboxBackendOptions`. They are baked into the backend at
 * construction time via the tier-specific config (see
 * {@link SandboxProviderConfig.layout} for the container tier). This
 * keeps `provider.create()` symmetric across tiers and prevents the
 * SDK runtime from accidentally calling a container backend without
 * a layout — the binding is at construction, not per-call.
 *
 * The backend does NOT see the agent or its tools — the SDK
 * composes them at the runtime layer. Backends are pure isolation
 * primitives.
 */
export interface SandboxBackend {
	readonly tier: SandboxTier
	readonly name: string

	create(options: SandboxBackendOptions): Promise<Sandbox>
}

/**
 * Per-call options handed to a backend's `create()`. Tier-agnostic
 * host knobs only:
 *
 *  - `workingDirectory` — the per-task root where the sandbox is
 *    rooted (e.g. `/tmp/<tenant>/<run>/`). Backends bind-mount or
 *    chroot this depending on platform.
 *  - `egress` — the allowlist policy applied to outbound network
 *    inside the sandbox. Backends translate this into proxy /
 *    iptables / domain-allowlist plumbing.
 *  - `timeoutMs`, `memoryLimitMb`, `maxProcesses` — resource caps
 *    applied per spawned process inside the sandbox.
 *  - `env` — environment variables added to the inside of the
 *    sandbox (NOT host process env). Used to forward
 *    `HTTP_PROXY` / `HTTPS_PROXY` to the egress proxy when one
 *    is in play.
 *
 * `layout` is **not** here — see the type-level note on
 * {@link SandboxBackend}. Identity-aware fields (tenantId / runId /
 * agentId) are deliberately NOT in this shape either; hosts that
 * need per-tenant sandbox config bake the tenant into the closure
 * that constructs the provider — see the `EgressPolicy` resolver
 * shape.
 */
export interface SandboxBackendOptions {
	/** Run authority for allocation/readiness. See `SandboxCreateConfig.signal`. */
	readonly signal?: AbortSignal
	readonly workingDirectory: string
	readonly egress?: EgressPolicy
	readonly timeoutMs?: number
	readonly memoryLimitMb?: number
	readonly maxProcesses?: number
	readonly env?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Provider factory (public)
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link createSandboxProvider}. The host picks
 * a tier-specific backend config (process / container / microvm /
 * passthrough) and supplies cross-tier defaults that
 * `provider.create()` calls can override.
 *
 * Container-tier backends require a per-task
 * {@link ContainerSandboxLayout} captured at construction time (see
 * the discriminated union). The layout is per-task — different
 * `hostPath`s for different runs — so hosts call
 * `createSandboxProvider` once per task with the task-specific
 * layout baked in. The `Sandbox` instance returned by
 * `provider.create()` then inherits that layout. This is the only
 * path: there is no per-call layout argument that could be silently
 * omitted by the SDK runtime.
 */
export type SandboxProviderConfig =
	| (SandboxProviderConfigBase & {
			readonly backend: ContainerBackendConfig
			readonly layout: ContainerSandboxLayout
	  })
	| (SandboxProviderConfigBase & {
			readonly backend: ACIStandbyPoolBackendConfig
			readonly layout: ContainerSandboxLayout
	  })
	| (SandboxProviderConfigBase & {
			readonly backend: MicroVMBackendConfig
	  })
	| (SandboxProviderConfigBase & {
			readonly backend: KubernetesBackendConfig
	  })

interface SandboxProviderConfigBase {
	readonly defaultEgress?: EgressPolicy
	readonly defaultTimeoutMs?: number
	readonly defaultMemoryLimitMb?: number
	readonly defaultMaxProcesses?: number
}

/**
 * Build a {@link SandboxProvider} the SDK can wire into
 * `drainQuery`'s `sandboxProvider` field. Selects the backend at
 * construction time; subsequent `provider.create()` calls all use
 * the chosen backend.
 *
 * Backends are loaded lazily — the package only imports the
 * platform-specific modules (the host sandbox runtime, the
 * Docker SDK, the microVM SDK, …) when the corresponding backend is
 * requested. That keeps `@namzu/sandbox` reasonable to install in
 * environments where one backend is genuinely impossible.
 *
 * Every shape in {@link SandboxBackendConfig} has a backend behind
 * it. That is a recent property: this file used to declare a staged
 * roadmap of tiers and adapters, most of which threw, so the surface
 * described a plan and the runtime described the truth. The shapes
 * that were never built are gone rather than pending — a config that
 * type-checks and can only throw teaches a caller the wrong thing
 * about what this package does.
 *
 * {@link SandboxBackendNotImplementedError} survives for the untyped
 * caller: a JS host that invents a tier gets a named refusal instead
 * of a provider that confines nothing.
 */
export function createSandboxProvider(config: SandboxProviderConfig): SandboxProvider {
	const backend = pickBackend(config)
	const id = `namzu-${backend.tier}-${backend.name}`
	const name = `@namzu/sandbox: ${describeBackend(config.backend)}`
	return {
		id,
		name,
		environment: 'basic',
		// This provider's workspace comes from the construction-time container
		// or microVM layout. A host cwd passed per run is not that mount and must
		// never be claimed as one.
		workspaceModes: ['ephemeral'],
		async create(perCall?: SandboxCreateConfig): Promise<Sandbox> {
			return await backend.create({
				...(perCall?.signal !== undefined ? { signal: perCall.signal } : {}),
				workingDirectory: perCall?.workingDirectory ?? '/workspace',
				...(config.defaultEgress !== undefined ? { egress: config.defaultEgress } : {}),
				...(perCall?.timeoutMs !== undefined
					? { timeoutMs: perCall.timeoutMs }
					: config.defaultTimeoutMs !== undefined
						? { timeoutMs: config.defaultTimeoutMs }
						: {}),
				...(perCall?.memoryLimitMb !== undefined
					? { memoryLimitMb: perCall.memoryLimitMb }
					: config.defaultMemoryLimitMb !== undefined
						? { memoryLimitMb: config.defaultMemoryLimitMb }
						: {}),
				...(perCall?.maxProcesses !== undefined
					? { maxProcesses: perCall.maxProcesses }
					: config.defaultMaxProcesses !== undefined
						? { maxProcesses: config.defaultMaxProcesses }
						: {}),
				...(perCall?.env !== undefined ? { env: perCall.env } : {}),
			})
		},
	}
}

function pickBackend(config: SandboxProviderConfig): SandboxBackend {
	const backend = config.backend
	// Checked ahead of the `docker` default below: `ACIStandbyPoolBackendConfig`
	// is a real arm of `SandboxProviderConfig` (see the discriminated union
	// above), discriminated from `ContainerBackendConfig` by `runtime`. A
	// plain equality check here narrows `backend` to the ACI shape with no
	// cast, and — because this branch always returns — narrows it AWAY for
	// every check below, so the `docker` branch's `backend.runtime ?? 'docker'`
	// still sees only `ContainerBackendConfig`.
	if (backend.tier === 'container' && backend.runtime === 'aci-standby-pool') {
		const layout = (config as Extract<SandboxProviderConfig, { layout: ContainerSandboxLayout }>)
			.layout
		const resolved = resolveLayout(layout)
		return buildAciStandbyPoolBackend({
			subscriptionId: backend.subscriptionId,
			resourceGroup: backend.resourceGroup,
			location: backend.location,
			standbyPoolResourceId: backend.standbyPoolResourceId,
			containerGroupProfileResourceId: backend.containerGroupProfileResourceId,
			...(backend.containerGroupProfileRevision !== undefined
				? { containerGroupProfileRevision: backend.containerGroupProfileRevision }
				: {}),
			layout: resolved,
			getArmToken: backend.getArmToken,
			...(backend.subnetId !== undefined ? { subnetId: backend.subnetId } : {}),
			...(backend.readyPollIntervalMs !== undefined
				? { readyPollIntervalMs: backend.readyPollIntervalMs }
				: {}),
			...(backend.readyTimeoutMs !== undefined ? { readyTimeoutMs: backend.readyTimeoutMs } : {}),
			...(backend.workerPort !== undefined ? { workerPort: backend.workerPort } : {}),
			...(backend.armApiVersion !== undefined ? { armApiVersion: backend.armApiVersion } : {}),
			...(backend.containerNamePrefix !== undefined
				? { containerNamePrefix: backend.containerNamePrefix }
				: {}),
		})
	}
	if (backend.tier === 'container' && (backend.runtime ?? 'docker') === 'docker') {
		// `layout` is required for container-tier backends by the
		// discriminated union — narrow safely without a non-null
		// assertion.
		const layout = (config as Extract<SandboxProviderConfig, { layout: ContainerSandboxLayout }>)
			.layout
		// Resolve once at construction. Validation throws synchronously
		// here, before the provider is returned, so any layout error
		// surfaces during host wiring rather than mid-run.
		const resolved = resolveLayout(layout)
		return buildDockerBackend({
			image: backend.image,
			layout: resolved,
			...(backend.readyTimeoutMs !== undefined ? { readyTimeoutMs: backend.readyTimeoutMs } : {}),
			...(backend.readyPollIntervalMs !== undefined
				? { readyPollIntervalMs: backend.readyPollIntervalMs }
				: {}),
			...(backend.hostReachability !== undefined
				? { hostReachability: backend.hostReachability }
				: {}),
			...(backend.network !== undefined ? { network: backend.network } : {}),
			...(backend.allowInwardFor !== undefined ? { allowInwardFor: backend.allowInwardFor } : {}),
			...(backend.labels !== undefined ? { labels: backend.labels } : {}),
		})
	}
	if (backend.tier === 'container' && backend.runtime === 'runsc') {
		const layout = (config as Extract<SandboxProviderConfig, { layout: ContainerSandboxLayout }>)
			.layout
		const resolved = resolveLayout(layout)
		return buildDockerBackend({
			image: backend.image,
			layout: resolved,
			runtime: 'runsc',
			...(backend.readyTimeoutMs !== undefined ? { readyTimeoutMs: backend.readyTimeoutMs } : {}),
			...(backend.readyPollIntervalMs !== undefined
				? { readyPollIntervalMs: backend.readyPollIntervalMs }
				: {}),
			...(backend.hostReachability !== undefined
				? { hostReachability: backend.hostReachability }
				: {}),
			...(backend.network !== undefined ? { network: backend.network } : {}),
			...(backend.allowInwardFor !== undefined ? { allowInwardFor: backend.allowInwardFor } : {}),
			...(backend.labels !== undefined ? { labels: backend.labels } : {}),
		})
	}
	// `microvm:self-hosted` targeting the OWNED Azure Firecracker
	// orchestrator (ses_051). The presence of `orchestratorEndpoint` +
	// `getToken` distinguishes the owned-platform shape from the legacy
	// local `firecracker-containerd` shape (still unimplemented → throws
	// below). No layout: FC is a remote-copy backend (archive-sync over
	// vsock, like ACI), so it carries no host bind-mount layout.
	if (
		backend.tier === 'microvm' &&
		backend.service === 'self-hosted' &&
		backend.orchestratorEndpoint !== undefined &&
		backend.getToken !== undefined
	) {
		return buildFirecrackerBackend({
			orchestratorEndpoint: backend.orchestratorEndpoint,
			getToken: backend.getToken,
			...(backend.template !== undefined ? { template: backend.template } : {}),
			...(backend.agentSnapshot !== undefined ? { agentSnapshot: backend.agentSnapshot } : {}),
			...(backend.agentVsockPort !== undefined ? { agentVsockPort: backend.agentVsockPort } : {}),
			...(backend.readyTimeoutMs !== undefined ? { readyTimeoutMs: backend.readyTimeoutMs } : {}),
			...(backend.readyPollIntervalMs !== undefined
				? { readyPollIntervalMs: backend.readyPollIntervalMs }
				: {}),
			...(backend.mtls !== undefined ? { mtls: backend.mtls } : {}),
			...(backend.controlPlaneMtls !== undefined
				? { controlPlaneMtls: backend.controlPlaneMtls }
				: {}),
		})
	}
	// `microvm:kubernetes` — agent-sandbox on any cluster. Reached through a
	// real arm of `SandboxProviderConfig`, so `backend` narrows here and every
	// field below is read off the narrowed type, same as the ACI and docker
	// branches above.
	if (backend.tier === 'microvm' && backend.service === 'kubernetes') {
		return buildKubernetesBackend(kubernetesInternalConfig(backend))
	}
	throw new SandboxBackendNotImplementedError(describeBackend(backend))
}

/**
 * Public config → the kubernetes backend's own. One function so the two
 * entry points that build against a cluster — {@link createSandboxProvider}
 * for task sandboxes and {@link createKubernetesWorkspace} for persistent
 * ones — cannot drift apart on which fields they forward.
 */
function kubernetesInternalConfig(
	backend: KubernetesBackendConfig,
): KubernetesBackendInternalConfig {
	return {
		access: backend.access,
		namespace: backend.namespace,
		sandboxTemplateName: backend.sandboxTemplateName,
		...(backend.warmPoolName !== undefined ? { warmPoolName: backend.warmPoolName } : {}),
		...(backend.agentPort !== undefined ? { agentPort: backend.agentPort } : {}),
		...(backend.agentAddress !== undefined ? { agentAddress: backend.agentAddress } : {}),
		...(backend.readyPollIntervalMs !== undefined
			? { readyPollIntervalMs: backend.readyPollIntervalMs }
			: {}),
		...(backend.readyTimeoutMs !== undefined ? { readyTimeoutMs: backend.readyTimeoutMs } : {}),
		...(backend.claimTtlSeconds !== undefined ? { claimTtlSeconds: backend.claimTtlSeconds } : {}),
		...(backend.onLeaseRenewalError !== undefined
			? { onLeaseRenewalError: backend.onLeaseRenewalError }
			: {}),
		...(backend.runtimeClassName !== undefined
			? { runtimeClassName: backend.runtimeClassName }
			: {}),
		...(backend.egress !== undefined ? { egress: backend.egress } : {}),
	}
}

/**
 * Create — or reattach to — a persistent workspace on a cluster running the
 * agent-sandbox controller.
 *
 * A workspace is the other half of this backend, and deliberately not
 * something {@link createSandboxProvider} can hand out: a `SandboxProvider`
 * promises an EPHEMERAL sandbox per run (`workspaceModes: ['ephemeral']`),
 * while this returns one object with a name the caller chose, a disk that
 * survives a suspend, and a lifetime nothing reaps on a timer. It is its own
 * verb so that the difference is visible at the call site.
 *
 * `config.warmPoolName` is ignored here: a workspace is always a `Sandbox`
 * POSTed directly, because a claim cannot carry the immutable disk spec.
 * `config.sandboxTemplateName` is the default template, and
 * `options.sandboxTemplateName` overrides it — a deployment normally has a
 * task template with no disk and a workspace template with a block one.
 *
 * Resolves once the workspace is Ready, addressed and has proved it is
 * deprivileged, exactly as `provider.create()` does for a task sandbox.
 */
export async function createKubernetesWorkspace(
	config: KubernetesBackendConfig,
	options: KubernetesWorkspaceOptions,
): Promise<KubernetesWorkspace> {
	return await buildKubernetesWorkspace(kubernetesInternalConfig(config), options)
}

/**
 * Every workspace this backend owns in the namespace, read off the objects
 * and waking none of them.
 *
 * The inventory {@link createKubernetesWorkspace} cannot give you: it adopts
 * AND resumes, so taking stock through it would start a pod for every
 * suspended workspace it looked at. This issues one GET of the sandboxes
 * collection and sends no PATCH and no DELETE — a suspended workspace is
 * still suspended afterwards.
 *
 * Needs `list` on `sandboxes` in the namespace, which is the one RBAC verb
 * the task path did not already require.
 */
export async function listKubernetesWorkspaces(
	config: KubernetesBackendConfig,
	options?: KubernetesWorkspaceTransitionOptions,
): Promise<readonly KubernetesWorkspaceSummary[]> {
	return await listWorkspacesOnCluster(kubernetesInternalConfig(config), options)
}

/**
 * Delete a workspace by id — the Sandbox, and with it the Pod, the Service
 * and the PVC — without adopting or resuming it first.
 *
 * Exactly what `destroy({ deleteDisk: true })` does to the cluster, with the
 * same guarantees: an object already gone counts as deleted, and a DELETE
 * that fails rejects and stays retryable. The files are gone and nothing
 * brings them back.
 *
 * It is the retention verb. Removing a month-old suspended workspace through
 * a handle meant starting its pod and probing it purely to tell it to go
 * away; the name is deterministic, so the object never needed opening.
 */
export async function deleteKubernetesWorkspace(
	config: KubernetesBackendConfig,
	workspaceId: string,
	options?: KubernetesWorkspaceTransitionOptions,
): Promise<void> {
	await deleteWorkspaceOnCluster(kubernetesInternalConfig(config), workspaceId, options)
}

/**
 * Suspend a workspace by id: send the `operatingMode: Suspended` patch and
 * wait for the pod to actually stop, without adopting the workspace.
 *
 * Resolves only once the pod is gone or in a terminal phase — a suspend is a
 * promise that the disk is quiesced, and the patch being accepted says only
 * that the controller has been asked. A pod that outlives `readyTimeoutMs`
 * rejects with `KubernetesWorkspaceSuspendTimeoutError`, leaving the object
 * as the patch left it.
 *
 * A handle another process is holding is not told. It finds out on its next
 * call — which fails at the transport and is re-read into a
 * `KubernetesWorkspaceSuspendedError` — or when that process calls
 * `refresh()`.
 */
export async function suspendKubernetesWorkspace(
	config: KubernetesBackendConfig,
	workspaceId: string,
	options?: KubernetesWorkspaceTransitionOptions,
): Promise<void> {
	await suspendWorkspaceOnCluster(kubernetesInternalConfig(config), workspaceId, options)
}

/**
 * Human-readable backend label for error messages. Returns the
 * tier plus the concrete service / runtime when present, e.g.
 * `'microvm:self-hosted'` or `'container:runsc'`.
 */
function describeBackend(config: SandboxBackendConfig): string {
	if (config.tier === 'microvm') return `microvm:${config.service}`
	return `container:${config.runtime ?? 'docker'}`
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by the factory when a backend is requested before its
 * implementation has landed. Makes the staged rollout legible —
 * consumers see exactly which backend is missing rather than a
 * generic `TypeError: foo is not a function`.
 *
 * Subclasses Error so existing host error handling (instanceof
 * checks, JSON.stringify, etc.) keeps working.
 */
export class SandboxBackendNotImplementedError extends Error {
	override readonly name = 'SandboxBackendNotImplementedError'

	constructor(public readonly backend: string) {
		super(
			`Sandbox backend '${backend}' is not implemented yet. See the backends listed in @namzu/sandbox for what ships today.`,
		)
	}
}

/**
 * Thrown when a {@link ContainerSandboxLayout} fails validation:
 * missing required `outputs` mount, malformed skill id, duplicate
 * skill id, duplicate `containerPath` across mounts. The `reasons`
 * array carries one entry per violation so consumers can surface
 * every problem in one round-trip rather than fix-then-rerun.
 *
 * **Transport caveat.** `JSON.stringify(err)` works because
 * `toJSON()` returns a plain object with `reasons` preserved. But
 * `structuredClone(err)` on the Error object itself drops the
 * subclass name and any non-enumerable fields. For transport
 * boundaries (postMessage, worker IPC, log shippers) call
 * {@link serializeSandboxError} which returns a plain object that
 * is `structuredClone`-safe and `JSON.stringify`-safe in one shape.
 */
export class ContainerSandboxLayoutValidationError extends Error {
	override readonly name = 'ContainerSandboxLayoutValidationError'

	constructor(
		public readonly reasons: readonly string[],
		options?: { cause?: unknown },
	) {
		super(
			`Invalid ContainerSandboxLayout: ${reasons.join('; ')}`,
			options?.cause !== undefined ? { cause: options.cause } : undefined,
		)
	}

	toJSON(): {
		name: string
		message: string
		reasons: readonly string[]
		cause?: unknown
	} {
		return {
			name: this.name,
			message: this.message,
			reasons: this.reasons,
			...(this.cause !== undefined ? { cause: this.cause } : {}),
		}
	}
}

/**
 * Transport-safe serialisation for any error this package raises
 * (and any nested `cause` chain). Returns a plain object with
 * `name`, `message`, optional `stack`, optional `cause`
 * (recursively serialised into the same envelope shape), and — for
 * {@link ContainerSandboxLayoutValidationError} — the `reasons`
 * array. The result is **uniformly safe** through
 * `structuredClone`, `postMessage`, and `JSON.stringify`:
 *
 *  - No function / Symbol / BigInt / non-finite-number values
 *    leak into the envelope; non-Error causes (and non-Error
 *    inputs) are converted to a typed envelope by
 *    {@link serializeNonErrorCause}.
 *  - Cycles (`a.cause = a`, `a.cause = b; b.cause = a`) are
 *    detected via a `WeakSet` and replaced with a
 *    `{ name: 'CircularReference', message: '[circular]' }`
 *    sentinel — no stack overflow, no `JSON.stringify` throw.
 *  - Deep chains are walked in full (no arbitrary depth cap); the
 *    cycle guard, not depth, is what bounds the recursion.
 *
 * Why this helper exists: `Error` subclasses don't survive any
 * structured-clone-like channel — `structuredClone(err)` drops the
 * subclass name and non-enumerable fields, `postMessage` follows
 * the same rules, and most log shippers serialise via JSON which
 * calls the unhelpful default `toJSON`. Vandal's supervisor
 * architecture crosses every one of those boundaries; explicit
 * serialisation keeps the `reasons[]` discoverable downstream.
 *
 * Use:
 * ```ts
 * try { ... }
 * catch (err) {
 *   logger.error(serializeSandboxError(err))
 *   parent.postMessage(serializeSandboxError(err))
 * }
 * ```
 */
export interface SerializedSandboxError {
	readonly name: string
	readonly message: string
	readonly stack?: string
	readonly reasons?: readonly string[]
	/**
	 * Recursively serialised cause envelope. Always the same shape;
	 * non-Error causes go through {@link serializeNonErrorCause}
	 * before they reach this slot, so values that `JSON.stringify`
	 * or `structuredClone` would choke on (Function, Symbol,
	 * BigInt, NaN, ±Infinity, undefined) never appear here.
	 */
	readonly cause?: SerializedSandboxError
}

/**
 * Convert a non-Error `cause` value into a typed envelope that is
 * safe through every transport channel. Categorises the input by
 * runtime type so the receiver can tell e.g. "this was a Symbol"
 * apart from "this was a string" without inspecting the message
 * format.
 */
function serializeNonErrorCause(value: unknown): SerializedSandboxError {
	if (value === null) return { name: 'NonError', message: 'null' }
	if (value === undefined) return { name: 'NonError', message: 'undefined' }
	if (typeof value === 'function') return { name: 'Function', message: '[function]' }
	if (typeof value === 'symbol') return { name: 'Symbol', message: value.toString() }
	if (typeof value === 'bigint') return { name: 'BigInt', message: value.toString() }
	if (typeof value === 'number' && !Number.isFinite(value)) {
		return { name: 'NonFiniteNumber', message: String(value) }
	}
	if (typeof value === 'string') return { name: 'NonError', message: value }
	if (typeof value === 'number' || typeof value === 'boolean') {
		return { name: 'NonError', message: String(value) }
	}
	// Plain objects / arrays — JSON-stringify with a fallback so
	// values that contain non-JSON-safe leaves (Symbol-keyed props,
	// BigInt, …) still produce a printable message.
	return { name: 'NonError', message: safeStringify(value) }
}

export function serializeSandboxError(err: unknown): SerializedSandboxError {
	return serializeWithGuard(err, new WeakSet())
}

function serializeWithGuard(err: unknown, seen: WeakSet<object>): SerializedSandboxError {
	// Non-Error inputs go through the typed-envelope path. Primitive
	// values can't participate in a cycle so the WeakSet is a no-op
	// for them; object inputs (plain objects, arrays) DO need the
	// cycle guard before `safeStringify` is reached.
	if (!(err instanceof Error)) {
		if (typeof err === 'object' && err !== null) {
			if (seen.has(err)) return { name: 'CircularReference', message: '[circular]' }
			seen.add(err)
		}
		return serializeNonErrorCause(err)
	}

	if (seen.has(err)) {
		return { name: 'CircularReference', message: '[circular]' }
	}
	seen.add(err)

	const out: {
		name: string
		message: string
		stack?: string
		reasons?: readonly string[]
		cause?: SerializedSandboxError
	} = {
		name: err.name,
		message: err.message,
	}
	if (err.stack !== undefined) out.stack = err.stack
	if (err instanceof ContainerSandboxLayoutValidationError) {
		out.reasons = err.reasons
	}
	// Walk the cause chain. The same `seen` set is threaded through
	// the recursion so a cycle detected at any depth replaces the
	// offending node with the sentinel rather than blowing the stack.
	if ('cause' in err && err.cause !== undefined) {
		out.cause = serializeWithGuard(err.cause, seen)
	}
	return out
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}
