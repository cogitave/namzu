/**
 * @namzu/sandbox — pluggable sandbox provider for @namzu/sdk.
 *
 * The SDK already declares a `SandboxProvider` shape in
 * `@namzu/sdk` (`packages/sdk/src/types/sandbox/index.ts`). This
 * package implements that shape with concrete BACKENDS:
 *
 *  • `process` — host-process isolation via Anthropic's
 *    `@anthropic-ai/sandbox-runtime` model: bubblewrap on Linux,
 *    `sandbox-exec` on macOS, an HTTP/SOCKS proxy outside the
 *    sandbox enforcing a domain allowlist. Suits developer dev
 *    loops where the agent runs on the user's actual machine and
 *    only needs a low-overhead "don't read /etc, don't dial
 *    evil.com" guard. Cold-start is process spawn (~ms).
 *
 *  • `container` — task-per-container isolation modelled on
 *    cogitave/compass-platform's `sandbox/` deployment pattern:
 *    a worker process inside an isolated Docker container speaks
 *    HTTP to the host, an egress proxy sidecar mediates outbound
 *    network with JWT-authenticated allowlists, and per-task
 *    workspaces are filesystem-isolated by virtue of being in
 *    their own container. Suits multi-tenant production where
 *    the host process must NOT trust the agent at all. Cold-start
 *    is seconds (container start) but blast radius is bounded by
 *    the kernel's container boundary.
 *
 *  • `passthrough` — no isolation, runs commands directly. For
 *    tests and trusted environments only. Off by default; opt-in.
 *
 * Backends are chosen at construction time. The `SandboxProvider`
 * surface the SDK consumes is identical across all three, so
 * swapping is a config change, not an integration rewrite.
 *
 * Why not gVisor / Firecracker / microsandbox? Per the
 * ses_004 design session research:
 *   - gVisor needs `runsc` runtime, unavailable on Azure
 *     Container Apps. Breaks dev/prod parity.
 *   - Firecracker / Kata / microsandbox need KVM. Same problem.
 *   - bubblewrap + Seatbelt is what Anthropic itself ships with
 *     Claude Code. Same code path runs under `docker compose up`
 *     locally and on a Linux replica in production.
 *   - Container backend gives an additional "host doesn't trust
 *     agent at all" tier for multi-tenant deployments without
 *     introducing a new isolation tech the SDK has to vendor.
 *
 * This file is the public surface. Concrete backend implementations
 * land under `./backends/` in subsequent commits — the
 * `SandboxBackend` interface here is the contract they implement.
 */

import type { Sandbox, SandboxProvider } from '@namzu/sdk'

// ---------------------------------------------------------------------------
// Backend strategy
// ---------------------------------------------------------------------------

/**
 * Discriminator for the concrete sandbox backend. Hosts pass this
 * to {@link createSandboxProvider}; the package looks up the
 * matching {@link SandboxBackend} implementation.
 *
 * Add a new backend by:
 *   1. Implementing {@link SandboxBackend} under
 *      `src/backends/<name>/index.ts`.
 *   2. Registering it in `src/backends/registry.ts` (added in P3.1).
 *   3. Extending this union with the new tag.
 */
export type SandboxBackendKind = 'process' | 'container' | 'passthrough'

/**
 * Egress allowlist resolution. The host-supplied policy decides
 * whether a given outbound request is allowed before the proxy
 * opens a socket.
 *
 * Two shapes:
 *   - **Static** — `{ kind: 'static', allowedHosts: string[] }`.
 *     Fixed at provider construction. Smallest surface, fine for
 *     deployments where the allowlist is the same across every
 *     run (e.g. "always allow `api.openai.com` and
 *     `api.anthropic.com`, deny everything else").
 *   - **Resolver** — `{ kind: 'resolver', resolve: (ctx) => ... }`.
 *     Re-evaluated per run. Right when the allowlist depends on
 *     the tenant, the run, the agent identity, or any other
 *     signal the host cares about. The compass-platform pattern.
 *
 * Hosts can also pass `{ kind: 'deny-all' }` (the default) to
 * deny ALL egress, or `{ kind: 'allow-all' }` (NOT recommended
 * for production) for tests.
 */
export type EgressPolicy =
	| { readonly kind: 'deny-all' }
	| { readonly kind: 'allow-all' }
	| { readonly kind: 'static'; readonly allowedHosts: readonly string[] }
	| {
			readonly kind: 'resolver'
			readonly resolve: (ctx: EgressResolveContext) => Promise<readonly string[]>
	  }

/**
 * Context passed to `EgressPolicy.resolve` callbacks. Lets the
 * host resolve the allowlist based on whatever signals it tracks.
 *
 * Intentionally narrow — `tenantId`, `runId`, `agentId` are the
 * three signals every sandbox-using namzu host has so far asked
 * about. Add fields here cautiously; an over-wide context locks
 * us into a contract.
 */
export interface EgressResolveContext {
	readonly tenantId?: string
	readonly runId?: string
	readonly agentId?: string
}

/**
 * Backend strategy. Each `SandboxBackendKind` ships a concrete
 * implementation of this interface in its own subfolder.
 *
 * Backends are responsible for:
 *  - turning {@link SandboxBackendOptions} into a concrete
 *    {@link Sandbox} instance the SDK can use,
 *  - wiring {@link EgressPolicy} into whatever proxy / network
 *    primitive the backend has,
 *  - cleaning up host resources on `destroy()` (process-level
 *    cleanup, container teardown, etc.).
 *
 * The backend does NOT see the agent or its tools — the SDK
 * composes them at the runtime layer. Backends are pure
 * isolation primitives.
 */
export interface SandboxBackend {
	readonly kind: SandboxBackendKind
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
 *  - `tenantId`, `runId`, `agentId` — propagated to
 *    {@link EgressResolveContext} when the policy is a resolver.
 */
export interface SandboxBackendOptions {
	readonly workingDirectory: string
	readonly egress?: EgressPolicy
	readonly timeoutMs?: number
	readonly memoryLimitMb?: number
	readonly maxProcesses?: number
	readonly env?: Record<string, string>
	readonly tenantId?: string
	readonly runId?: string
	readonly agentId?: string
}

// ---------------------------------------------------------------------------
// Provider factory (public)
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link createSandboxProvider}. Hosts pick the
 * backend tag here; everything else mirrors
 * {@link SandboxBackendOptions} but applied as DEFAULTS that each
 * `provider.create()` call can override.
 */
export interface SandboxProviderConfig {
	readonly backend: SandboxBackendKind
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
 * platform-specific modules (`bubblewrap`, `sandbox-exec`, the
 * Docker SDK, …) when the corresponding backend is requested.
 * That keeps `@namzu/sandbox` reasonable to install in
 * environments where one backend is genuinely impossible (e.g.
 * pure CI containers without `runsc`, dev laptops without
 * Docker, etc.).
 *
 * **Not implemented in this commit** — this file declares the
 * surface; backends arrive in P3.1 (process), P3.2 (egress
 * policy plumbing), P3.3 (container). Calling this function now
 * throws `SANDBOX_BACKEND_NOT_IMPLEMENTED` so consumers get a
 * clear signal during the staged rollout.
 */
export function createSandboxProvider(_config: SandboxProviderConfig): SandboxProvider {
	throw new SandboxBackendNotImplementedError(_config.backend)
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

	constructor(public readonly backend: SandboxBackendKind) {
		super(
			`Sandbox backend '${backend}' is not implemented yet. Track progress in vendor/namzu/docs.local/sessions/ses_004-native-agentic-runtime-and-sandbox.`,
		)
	}
}
