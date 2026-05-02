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

import type { Sandbox, SandboxProvider } from '@namzu/sdk'

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
	| MicroVMBackendConfig
	| PassthroughBackendConfig

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
 * Options handed to a backend's `create()`. Covers the host-
 * provided knobs every backend needs:
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
 * Identity-aware fields (tenantId / runId / agentId) are
 * deliberately NOT in this shape. The SDK runtime does not
 * propagate them through `provider.create` calls today, so adding
 * them to the contract would be a lie. Hosts that need per-tenant
 * sandbox config bake the tenant into the closure that constructs
 * the provider — see the `EgressPolicy` resolver shape.
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
 */
export interface SandboxProviderConfig {
	readonly backend: SandboxBackendConfig
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
export function createSandboxProvider(_config: SandboxProviderConfig): SandboxProvider {
	throw new SandboxBackendNotImplementedError(describeBackend(_config.backend))
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
