/**
 * @namzu/sandbox — pluggable sandbox provider for @namzu/sdk.
 *
 * The SDK already declares a `SandboxProvider` shape in
 * `@namzu/sdk` (`packages/sdk/src/types/sandbox/index.ts`). This
 * package implements that shape with concrete BACKENDS picked at
 * construction time. The set is aligned with the 2026 industrial
 * standard for AI-agent code-execution sandboxes:
 *
 *  • `docker` — plain OCI container per task, seccomp default
 *    profile, tmpfs workdir, no-network-by-default. The universal
 *    fallback every namzu host gets locally with `docker compose`
 *    and on every Linux replica in any cloud. What Northflank /
 *    Railway / Render / Compass-platform / GitHub Actions runners
 *    actually ship for code execution. Trust boundary: namespaces.
 *
 *  • `e2b` — adapter for E2B's managed Firecracker microVM service
 *    (`e2b.dev`). Sub-second cold-start via snapshot/restore, full
 *    kernel-level trust boundary. The SaaS-friendly path to real
 *    Firecracker isolation without running our own scheduler.
 *
 *  • `fly-machines` — adapter for Fly Machines (`fly.io/docs/machines`).
 *    Also Firecracker microVMs; closer to bare-metal control than
 *    E2B, useful when the workload is more "arbitrary tool calls"
 *    than "Python REPL".
 *
 *  • `firecracker` — self-hosted `firecracker-containerd` on bare
 *    metal (or KVM-enabled cloud instance). For hosts that need
 *    Firecracker isolation AND insist on running the scheduler
 *    themselves. Tier 3 isolation, highest operational cost.
 *
 *  • `gvisor` — adapter for `runsc` runtime (Google's userspace
 *    kernel). What OpenAI Code Interpreter and Modal Labs ship.
 *    Trusted-tenant tier with near-zero cold-start; runs on
 *    commodity Linux without nested virt. Locally via Linux Docker
 *    runtime; not available on macOS Docker Desktop.
 *
 *  • `passthrough` — no isolation, runs commands directly. For
 *    tests and trusted environments only. Off by default; opt-in.
 *
 * **What we deliberately do NOT build** is yet-another Firecracker
 * scheduler — that is E2B's and Fly's entire product, and writing
 * our own is a years-long detour. We adapt to theirs.
 *
 * **Cloud portability:** the backend interface is cloud-agnostic.
 * `docker` works on every cloud; `e2b` and `fly-machines` are
 * managed services not tied to any cloud; `firecracker` and
 * `gvisor` need infrastructure the host chooses (GKE Sandbox, AWS
 * Fargate, self-hosted KVM, etc.). Picking a stronger backend may
 * imply moving cloud — that's the host's call, not the SDK's.
 *
 * **Local dev story:** Phase 1 (`docker`) runs everywhere. Phase 2
 * (`e2b` / `fly-machines`) hits the managed service from a dev
 * laptop with no infra setup. Phase 3 (`firecracker` / `gvisor`)
 * needs Lima/Colima on macOS or native KVM on Linux — only the
 * adversarial-multi-tenant prod path needs that and it's clearly
 * documented as such.
 *
 * This file is the public surface. Concrete backend implementations
 * land under `./backends/<kind>/` in subsequent commits — the
 * `SandboxBackend` interface here is the contract they implement.
 *
 * Refs: `e2b.dev/docs/sandbox`, `fly.io/docs/machines`,
 * `firecracker-microvm.github.io`, `gvisor.dev/docs`,
 * `cloud.google.com/kubernetes-engine/docs/concepts/sandbox-pods`,
 * `aws.amazon.com/blogs/aws/firecracker-lightweight-virtualization-for-serverless-computing`.
 */

import type {
	ContainerSandboxLayout,
	Sandbox,
	SandboxCreateConfig,
	SandboxProvider,
} from '@namzu/sdk'

import { buildAciStandbyPoolBackend } from './backends/aci-standby-pool/index.js'
import { buildDockerBackend, resolveLayout } from './backends/docker/index.js'

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

// ---------------------------------------------------------------------------
// Backend strategy
// ---------------------------------------------------------------------------

/**
 * Top-level sandbox tier. Each tier is a use-case bucket:
 *
 *   - `process` — the agent runs on the developer's own host;
 *     the sandbox keeps it from reading `~/.ssh` or running
 *     `rm -rf ~`. Single-user; no multi-tenancy. What Anthropic
 *     ships with Claude Code via `@anthropic-ai/sandbox-runtime`.
 *
 *   - `container` — the agent runs inside an OCI container per
 *     task. Same code path locally (`docker compose`) and on
 *     Linux replicas in any cloud. The default for "trusted
 *     prompts, contained workloads" — Northflank, Railway,
 *     Render, Compass-platform, GitHub Actions runners all
 *     ship this tier.
 *
 *   - `microvm` — the agent runs inside a Firecracker microVM
 *     per task. Hardware-virtualization trust boundary; the
 *     industry standard for adversarial multi-tenancy
 *     (AWS Lambda/Fargate, Fly Machines, Replit, E2B, Daytona
 *     all converged here). Sub-second cold-start via
 *     snapshot/restore.
 *
 *   - `passthrough` — no isolation; for tests and explicitly
 *     trusted environments.
 *
 * The concrete implementation inside a tier is picked via the
 * tier-specific config (see {@link ProcessBackendConfig},
 * {@link ContainerBackendConfig}, {@link MicroVMBackendConfig}).
 */
export type SandboxTier = 'process' | 'container' | 'microvm' | 'passthrough'

/**
 * Discriminated union of sandbox backend configurations. Each
 * tier has its own configuration shape — picking a tier picks the
 * shape automatically via TS narrowing.
 */
export type SandboxBackendConfig =
	| ProcessBackendConfig
	| ContainerBackendConfig
	| ACIStandbyPoolBackendConfig
	| MicroVMBackendConfig
	| PassthroughBackendConfig

/**
 * Azure Container Instances Standby Pool backend. Container tier,
 * managed-microvm-ish: every claim is a fresh ACI container group
 * pre-warmed in an Azure-managed standby pool (`Microsoft.StandbyPool`).
 * ~1.5 s claim latency vs ~10-30 s for cold ACI spawn. Trust boundary
 * = Microsoft's ACI isolation host (gVisor-equivalent depending on
 * SKU; AMD SEV-SNP TEE when the pool is created with sku=Confidential).
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
	readonly readyPollIntervalMs?: number
	readonly readyTimeoutMs?: number
	readonly workerPort?: number
	readonly armApiVersion?: string
}

/**
 * `process` tier. Auto-detects the platform's native primitive
 * unless overridden:
 *
 *   - `bubblewrap` on Linux / WSL2 (`bwrap`)
 *   - `seatbelt` on macOS (`sandbox-exec`)
 *
 * Both are what `@anthropic-ai/sandbox-runtime` ships. Cold-start
 * is process spawn (~ms). Use this when the agent runs on the
 * end-user's developer machine — Claude Code's deployment model.
 */
export interface ProcessBackendConfig {
	readonly tier: 'process'
	readonly engine?: 'auto' | 'bubblewrap' | 'seatbelt'
}

/**
 * `container` tier. Two runtime options:
 *
 *   - `docker` (default) — plain OCI container on the host's
 *     Docker daemon. No special runtime required.
 *   - `runsc` — Google's gVisor userspace-kernel runtime. Stronger
 *     isolation (syscall-table separation), runs on commodity
 *     Linux without nested virt. Trusted-tenant tier; what OpenAI
 *     Code Interpreter and Modal Labs ship. Requires the
 *     `runsc` runtime installed on the Docker daemon (Linux only;
 *     Docker Desktop on macOS does not support it). See
 *     `gvisor.dev/docs/user_guide/quick_start/docker`.
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
	 * `'none'` (no inbound or outbound network). Set to a docker
	 * bridge name when `hostReachability='container-network'` so the
	 * SDK consumer (also on that bridge) can reach the worker by
	 * container DNS name. Egress from the sandbox is governed
	 * separately by `EgressPolicy`.
	 */
	readonly network?: 'none' | 'bridge' | string
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
 * `microvm` tier. Three concrete services, all Firecracker under
 * the hood:
 *
 *   - `e2b` — adapter for E2B's managed sandbox service
 *     (`e2b.dev`). TS SDK does the scheduler work; namzu wraps it.
 *     ~150ms cold-start (snapshot/restore). Apache-2.0 server side,
 *     so the same code path can run against self-hosted E2B if
 *     the host eventually wants to leave the managed service.
 *   - `fly-machines` — adapter for Fly Machines
 *     (`fly.io/docs/machines`). Closer to bare-metal control than
 *     E2B; the right tier when the workload is "arbitrary tool
 *     calls" rather than "Python REPL".
 *   - `self-hosted` — direct `firecracker-containerd` against a
 *     KVM-enabled host. For deployments where E2B and Fly are
 *     both off the table for policy reasons. Operationally the
 *     heaviest path; everything below ships first.
 *
 * Local dev: `e2b` and `fly-machines` work from any laptop with
 * an API key (no infra setup). `self-hosted` requires Linux + KVM
 * (Lima/Colima on macOS).
 */
export type MicroVMBackendConfig =
	| {
			readonly tier: 'microvm'
			readonly service: 'e2b'
			readonly apiKey: string
			readonly template?: string
	  }
	| {
			readonly tier: 'microvm'
			readonly service: 'fly-machines'
			readonly apiToken: string
			readonly app: string
			readonly image: string
			readonly region?: string
	  }
	| {
			readonly tier: 'microvm'
			readonly service: 'self-hosted'
			readonly firecrackerBinary: string
			readonly kernelImage: string
			readonly rootfsImage: string
	  }

/**
 * `passthrough` tier. No isolation — runs commands directly in
 * the host process. Tests and trusted environments only.
 */
export interface PassthroughBackendConfig {
	readonly tier: 'passthrough'
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
			readonly backend: ProcessBackendConfig | MicroVMBackendConfig | PassthroughBackendConfig
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
 * platform-specific modules (Anthropic's sandbox-runtime, the
 * Docker SDK, the E2B SDK, …) when the corresponding backend is
 * requested. That keeps `@namzu/sandbox` reasonable to install in
 * environments where one backend is genuinely impossible.
 *
 * **Not implemented in this commit** — this file declares the
 * surface; backends arrive in subsequent commits per the ses_004
 * phase plan:
 *
 *   - **P3.1** — `container` (docker runtime). Phase 1: ship now.
 *   - **P3.2** — `EgressPolicy` plumbing + reference egress proxy.
 *   - **P3.3** — `microvm` (E2B + Fly Machines adapters). Phase 2.
 *   - **P3.4** — `process` (Anthropic sandbox-runtime adapter).
 *   - **P3.5** — `microvm` (self-hosted firecracker-containerd) +
 *     `container` (gVisor runtime). Phase 3 adversarial-multi-tenant.
 *
 * Calling this function now throws
 * {@link SandboxBackendNotImplementedError} so consumers get a
 * clear signal during the staged rollout.
 */
export function createSandboxProvider(config: SandboxProviderConfig): SandboxProvider {
	const backend = pickBackend(config)
	const id = `namzu-${backend.tier}-${backend.name}`
	const name = `@namzu/sandbox: ${describeBackend(config.backend)}`
	return {
		id,
		name,
		environment: 'basic',
		async create(perCall?: SandboxCreateConfig): Promise<Sandbox> {
			return await backend.create({
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
			...(backend.hostReachability !== undefined
				? { hostReachability: backend.hostReachability }
				: {}),
			...(backend.network !== undefined ? { network: backend.network } : {}),
			...(backend.labels !== undefined ? { labels: backend.labels } : {}),
		})
	}
	if (
		backend.tier === 'container' &&
		(backend as unknown as { runtime?: string }).runtime === 'aci-standby-pool'
	) {
		const aciBackend = backend as unknown as ACIStandbyPoolBackendConfig
		const layout = (config as Extract<SandboxProviderConfig, { layout: ContainerSandboxLayout }>)
			.layout
		const resolved = resolveLayout(layout)
		return buildAciStandbyPoolBackend({
			subscriptionId: aciBackend.subscriptionId,
			resourceGroup: aciBackend.resourceGroup,
			location: aciBackend.location,
			standbyPoolResourceId: aciBackend.standbyPoolResourceId,
			containerGroupProfileResourceId: aciBackend.containerGroupProfileResourceId,
			...(aciBackend.containerGroupProfileRevision !== undefined
				? { containerGroupProfileRevision: aciBackend.containerGroupProfileRevision }
				: {}),
			layout: resolved,
			getArmToken: aciBackend.getArmToken,
			...(aciBackend.subnetId !== undefined ? { subnetId: aciBackend.subnetId } : {}),
			...(aciBackend.readyPollIntervalMs !== undefined
				? { readyPollIntervalMs: aciBackend.readyPollIntervalMs }
				: {}),
			...(aciBackend.readyTimeoutMs !== undefined
				? { readyTimeoutMs: aciBackend.readyTimeoutMs }
				: {}),
			...(aciBackend.workerPort !== undefined ? { workerPort: aciBackend.workerPort } : {}),
			...(aciBackend.armApiVersion !== undefined
				? { armApiVersion: aciBackend.armApiVersion }
				: {}),
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
			...(backend.hostReachability !== undefined
				? { hostReachability: backend.hostReachability }
				: {}),
			...(backend.network !== undefined ? { network: backend.network } : {}),
			...(backend.labels !== undefined ? { labels: backend.labels } : {}),
		})
	}
	throw new SandboxBackendNotImplementedError(describeBackend(backend))
}

/**
 * Human-readable backend label for error messages. Returns the
 * tier plus the concrete service / runtime when present, e.g.
 * `'microvm:e2b'` or `'container:runsc'`.
 */
function describeBackend(config: SandboxBackendConfig): string {
	if (config.tier === 'microvm') return `microvm:${config.service}`
	if (config.tier === 'container') return `container:${config.runtime ?? 'docker'}`
	if (config.tier === 'process') return `process:${config.engine ?? 'auto'}`
	return config.tier
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
			`Sandbox backend '${backend}' is not implemented yet. Track progress in vendor/namzu/docs.local/sessions/ses_004-native-agentic-runtime-and-sandbox.`,
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
