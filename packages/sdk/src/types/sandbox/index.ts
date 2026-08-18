import { z } from 'zod'
import {
	SANDBOX_DEFAULT_MAX_PROCESSES,
	SANDBOX_DEFAULT_MEMORY_LIMIT_MB,
	SANDBOX_DEFAULT_TIMEOUT_MS,
} from '../../constants/sandbox/index.js'
import type { OpenTerminalOptions, TerminalSession } from '../../sandbox/terminal.js'
import type { SandboxId } from '../ids/index.js'

// ---------------------------------------------------------------------------
// Sandbox status — lifecycle state machine
// ---------------------------------------------------------------------------

export type SandboxStatus = 'creating' | 'ready' | 'busy' | 'destroyed'

export function assertSandboxStatus(status: SandboxStatus): void {
	switch (status) {
		case 'creating':
		case 'ready':
		case 'busy':
		case 'destroyed':
			return
		default: {
			const _exhaustive: never = status
			throw new Error(`Unknown SandboxStatus: ${_exhaustive}`)
		}
	}
}

// ---------------------------------------------------------------------------
// Sandbox environment — detected platform capability
// ---------------------------------------------------------------------------

export type SandboxEnvironment = 'linux-bwrap' | 'linux-namespace' | 'macos-seatbelt' | 'basic'

/**
 * Every tier, in the order a detector prefers them: strongest first.
 *
 * Exported because the alternative is what was there — a hand-written
 * alternation in a doctor test that had to be edited by whoever added a tier,
 * and was not, so the first new tier in a year failed a test that was
 * describing the tier list rather than checking anything about it.
 *
 * `assertSandboxEnvironment` reads this too, so the union, the runtime list and
 * the exhaustive check cannot drift apart.
 */
export const SANDBOX_ENVIRONMENTS: readonly SandboxEnvironment[] = [
	'linux-bwrap',
	'macos-seatbelt',
	'linux-namespace',
	'basic',
]

/**
 * A security control a sandbox tier either provides or does not.
 *
 * The environment name alone does not say what a caller actually gets:
 * one tier denies the network outright while another leaves the host
 * filesystem fully visible, and both used to answer to the same provider
 * name. A caller that turned isolation on for a reason needs to state
 * which control it is relying on, so a host that cannot supply it can
 * refuse instead of quietly handing back less.
 *
 *  - `filesystem` — the spawned process cannot read or write outside the
 *    sandbox root.
 *  - `network` — the spawned process cannot reach the network.
 *  - `process` — the spawned process cannot see or signal host processes.
 */
export type SandboxIsolationControl = 'filesystem' | 'network' | 'process'

export const SANDBOX_ISOLATION_CONTROLS: readonly SandboxIsolationControl[] = [
	'filesystem',
	'network',
	'process',
]

/** What a tier actually enforces, per control. */
export type SandboxIsolationReport = Readonly<Record<SandboxIsolationControl, boolean>>

export function assertSandboxEnvironment(env: SandboxEnvironment): void {
	// Membership, not a switch. A `case` per tier is a second list to keep in
	// step with the union, and the switch's `never` arm only catches a tier
	// ADDED to the union — never one added here and forgotten there.
	if (SANDBOX_ENVIRONMENTS.includes(env)) return
	throw new Error(`Unknown SandboxEnvironment: ${env}`)
}

// ---------------------------------------------------------------------------
// Exec result
// ---------------------------------------------------------------------------

export interface SandboxExecResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
	readonly signal?: string
	readonly timedOut: boolean
	readonly durationMs: number
	/**
	 * Set when the backend clipped the stream at its output cap.
	 *
	 * The firecracker protocol already computed these, but they had no slot
	 * in this contract, so they were dropped at the type boundary and the
	 * model saw a complete-looking result that had silently lost its tail —
	 * against the kernel's own convention that it does not truncate
	 * silently.
	 */
	readonly stdoutTruncated?: boolean
	readonly stderrTruncated?: boolean
}

// ---------------------------------------------------------------------------
// Exec options
// ---------------------------------------------------------------------------

export interface SandboxExecOptions {
	readonly timeout?: number
	readonly env?: Record<string, string>
	readonly cwd?: string
	/**
	 * Called as output arrives, before the command has finished.
	 *
	 * Every container-tier worker already streams its output a chunk at a
	 * time — the wire carries `stdout_delta` and `stderr_delta` events —
	 * and every backend concatenated them into a string and returned that
	 * when the process exited. So a command that takes eight minutes said
	 * nothing for eight minutes, on a transport that had been reporting
	 * the whole time.
	 *
	 * Additive and optional: a backend that cannot stream simply never
	 * calls it, and `SandboxExecResult.stdout` still carries the complete
	 * output either way. A caller that wants only the result ignores this
	 * and behaves exactly as before.
	 *
	 * The callback must not throw and must not be awaited — it is on the
	 * read path of a running process, so a slow or failing consumer would
	 * otherwise become a slow or failing command.
	 */
	readonly onOutput?: (chunk: {
		readonly stream: 'stdout' | 'stderr'
		readonly data: string
	}) => void
	/**
	 * Cancellation for the command. A backend that honours it kills the
	 * process; one that does not simply ignores it, so this is additive.
	 *
	 * Without it a Stop (or a per-tool deadline) could only ever abandon
	 * the *wait* — the sandboxed process kept running after the host
	 * believed the run had been cancelled.
	 *
	 * **Who honours it.** The in-process local sandbox does: the signal is
	 * merged with the call's own deadline and reaches `spawn`, so the child
	 * dies. The remote backends do not, and deliberately: their wire has no
	 * cancel op, so aborting the request would abandon the wait and leave the
	 * command running — the failure above, wearing the appearance of a fix.
	 * They will honour it when their protocols carry a cancel.
	 *
	 * Passing it is therefore always safe and never harmful; whether it takes
	 * effect depends on the backend.
	 */
	readonly signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// File listing — used by hosts that drain agent-produced output files
// out of the sandbox before destroy (walk-and-pull outputs flow).
// ---------------------------------------------------------------------------

/**
 * One regular file inside the sandbox filesystem. Backends return
 * absolute paths so the caller can pass each path straight back to
 * {@link Sandbox.readFile} without re-anchoring.
 */
export interface SandboxFileEntry {
	readonly path: string
	readonly size: number
}

// ---------------------------------------------------------------------------
// Sandbox interface — the core abstraction
// ---------------------------------------------------------------------------

/**
 * A network policy applied to a LIVE sandbox.
 *
 * The whole point is that it can change mid-life. The common shape —
 * "fetch the repository with a token, then drop to deny-all before running
 * anything the repository contains" — was not expressible at all: the
 * policy was frozen at provider construction, so a host had to build a
 * second provider and a second sandbox, copying the work across.
 */
export interface SandboxNetworkPolicy {
	/**
	 * Hosts the sandbox may reach. Empty denies everything.
	 *
	 * `api.example.com` matches that host; `.example.com` matches the
	 * domain and its subdomains. Substring matching is deliberately not
	 * offered — `example.com` as a substring would admit
	 * `example.com.attacker.net`.
	 */
	readonly allowedHosts: readonly string[]
}

export interface Sandbox {
	readonly id: SandboxId
	readonly status: SandboxStatus
	readonly rootDir: string
	readonly environment: SandboxEnvironment
	exec(command: string, args?: string[], opts?: SandboxExecOptions): Promise<SandboxExecResult>

	/**
	 * Narrow or widen what this sandbox can reach, while it is running.
	 *
	 * Optional, and a backend that cannot enforce it must **throw** rather
	 * than accept and ignore. A network policy that is accepted and not
	 * applied is worse than one that was never offered: the caller stops
	 * looking, and the run proceeds believing it is confined. That is the
	 * same rule the tiered sandbox provider follows, for the same reason.
	 */
	setNetworkPolicy?(policy: SandboxNetworkPolicy): Promise<void>

	/**
	 * Open a real pseudo-terminal whose complete process tree is confined to
	 * and owned by this sandbox.
	 *
	 * Optional, and a backend that cannot provide one must **throw** rather
	 * than hand back a pipe — the same rule {@link Sandbox.setNetworkPolicy}
	 * states one line up, and for a sharper reason. A pipe would appear to
	 * work: bytes would flow, and every program that calls `isatty` would
	 * take its non-interactive branch. The prompt never appears, the REPL
	 * exits immediately, the progress bar prints ten thousand lines, and
	 * nothing says why.
	 *
	 * A backend that implements this method MUST make {@link destroy} kill and
	 * await every terminal it returned. Merely starting a host pseudo-terminal
	 * with `rootDir` as its working directory does not satisfy either the
	 * confinement or the ownership contract.
	 *
	 * @deprecated No built-in backend currently satisfies both guarantees.
	 * Use a separately owned terminal backend; this member will be removed in
	 * a future major release after the repository's deprecation window.
	 */
	openTerminal?(options: OpenTerminalOptions): Promise<TerminalSession>
	writeFile(path: string, content: string | Buffer): Promise<void>
	readFile(path: string): Promise<Buffer>
	/**
	 * Recursively enumerate regular files under `rootPath`. Directories,
	 * symlinks, sockets, and other non-regular entries are skipped.
	 * Returns absolute paths so the caller can feed each into
	 * {@link readFile} directly.
	 *
	 * Used by hosts that drain agent-produced output files out of the
	 * sandbox before {@link destroy} (object-store-first persistence
	 * pattern; the sandbox's own filesystem is ephemeral).
	 *
	 * Implementations:
	 *  - Local / process-tier backends: `fs.readdir` recursively.
	 *  - Container-tier backends: `exec('find', [rootPath, '-type', 'f', …])`
	 *    against the worker, output parsed line-by-line.
	 *
	 * Implementations SHOULD return an empty array if `rootPath` does
	 * not exist (the agent may not have written anything yet). They
	 * MAY throw for other I/O failures.
	 */
	listFiles(rootPath: string): Promise<readonly SandboxFileEntry[]>
	destroy(): Promise<void>
}

// ---------------------------------------------------------------------------
// Container sandbox layout — multi-mount taxonomy (container-tier specific)
// ---------------------------------------------------------------------------
//
// Why the `Container` prefix on these types: the layout shape encodes
// container-tier semantics (bind-mount sources, `/mnt/...` container
// paths, RW outputs surface). A microVM tier carries
// layout-equivalent state that does not map onto bind-mount flags —
// snapshots, attached volumes, a rootfs pulled from a registry.
// Naming the public type
// `SandboxLayout` would either (a) make every future microVM adapter
// pretend its volume model fits a bind-mount shape, or (b) force a
// breaking rename when we add `MicroVMSandboxLayout` later. Naming
// it `ContainerSandboxLayout` from day one keeps the scope explicit
// and leaves room for `MicroVMSandboxLayout` (or whatever the right
// abstraction turns out to be) to land additively.

/**
 * Source of a container mount's data on the host side. Tagged union;
 * the discriminator lets a backend reject sources it can't honour
 * instead of guessing. Each variant is interpreted by exactly one
 * class of backend:
 *
 *  - `hostDir` — bind-mount from a path on the host filesystem.
 *    Docker / Podman / containerd / Firecracker virtio-fs all
 *    consume this. Local-dev tier and self-host VM tier.
 *
 *  - `azureFileShare` — mount an Azure Files SMB share into the
 *    container. Used by managed Azure Container Instances (incl.
 *    Standby Pool) which have no host filesystem to bind from; the
 *    Vandal-side host provisions a per-task share before claim and
 *    the ACI backend translates this variant to ACI's `volume +
 *    azureFile` shape.
 */
export type ContainerSandboxMountSource =
	| { readonly type: 'hostDir'; readonly hostPath: string }
	| {
			readonly type: 'azureFileShare'
			readonly storageAccountName: string
			readonly shareName: string
			/**
			 * Per-share access key. ACI accepts the storage account key
			 * inline on the volume definition. Hosts that want a tighter
			 * surface can issue a per-share SAS upstream; the backend
			 * accepts the key here verbatim — it never reads from env.
			 */
			readonly storageAccountKey: string
	  }
	| {
			/**
			 * No external mount — the image itself provides the directory.
			 * Used by managed-warm-pool backends (ACI Standby Pool) whose
			 * claim semantics forbid per-task volume overrides. The
			 * container's own ephemeral filesystem carries the run; the
			 * host walks output files out via the worker's HTTP API
			 * before destroy and persists them somewhere durable
			 * (e.g. blob storage).
			 */
			readonly type: 'inImage'
	  }

/**
 * One container mount carrying a packaged skill bundle. The default
 * `containerPath` is `/mnt/skills/<id>`.
 */
export interface ContainerSandboxSkillMount {
	readonly id: string
	readonly source: ContainerSandboxMountSource
	readonly containerPath?: string
}

/**
 * One container mount: source + optional in-container path. Building
 * block of {@link ContainerSandboxLayout}.
 */
export interface ContainerSandboxLayoutMount {
	readonly source: ContainerSandboxMountSource
	readonly containerPath?: string
}

/**
 * Declarative multi-mount taxonomy for a CONTAINER sandbox. A container
 * needs one place the user will see and several the user will not, and
 * the difference has to be legible to the model from the path alone:
 *
 *  - `outputs` — RW bind. User-visible output surface that the
 *    user consumes after the run. Default container path
 *    `/mnt/user-data/outputs`. **Required** for container backends:
 *    without it the model has no place to persist work past the
 *    container's lifetime.
 *
 *  - `uploads` — RO bind. Files the user attached to the
 *    conversation. Default container path `/mnt/user-data/uploads`.
 *
 *  - `toolResults` — RO bind. Cached fetches / search results
 *    surfaced from prior tool calls. Default container path
 *    `/mnt/user-data/tool_results`.
 *
 *  - `skills` — RO list, one per skill bundle. Container path
 *    defaults to `/mnt/skills/<id>` per entry.
 *
 *  - `transcripts` — RO bind. Prior conversation transcripts the
 *    model can reference. Default container path `/mnt/transcripts`.
 *
 * **Scratchpad is intentionally absent.** The container-internal RW
 * area (`/home/<imageUser>` by reference Dockerfile convention) is
 * an image-bake responsibility — there is no public knob to declare
 * it because no backend bind-mounts it. Putting it in the layout
 * type would advertise a switch the runtime cannot honour.
 *
 * `outputs.containerPath` becomes the workspace root the worker
 * resolves against.
 *
 * The `Container` prefix is load-bearing: this shape is specific to
 * the container tier. MicroVM and process tiers will carry their
 * own layout types (e.g. `MicroVMSandboxLayout`) when their
 * adapters land.
 */
export interface ContainerSandboxLayout {
	readonly outputs: ContainerSandboxLayoutMount
	readonly uploads?: ContainerSandboxLayoutMount
	/**
	 * Working/scratch space for the agent. Sibling mount to `outputs`,
	 * not a child of it: the output collector / output watcher
	 * scans `outputs` only, so anything the agent writes under
	 * `scratch` is invisible to the user by construction. Mirrors the
	 * separation between scratch space (invisible to the collector) and
	 * `/mnt/user-data/outputs` as the user-visible output area).
	 * Hosts that don't need a separate scratch mount may omit this.
	 */
	readonly scratch?: ContainerSandboxLayoutMount
	readonly toolResults?: ContainerSandboxLayoutMount
	readonly skills?: readonly ContainerSandboxSkillMount[]
	readonly transcripts?: ContainerSandboxLayoutMount
}

/**
 * Same shape as {@link ContainerSandboxLayout}, but every container
 * path is resolved (no defaults left implicit). Backends produce
 * this internally and pass it to the mount-flag renderer. Exported
 * so advanced consumers (test harnesses, prompt template generators)
 * can inspect the post-default layout the model actually sees.
 */
export interface ResolvedContainerSandboxLayout {
	readonly outputs: { readonly source: ContainerSandboxMountSource; readonly containerPath: string }
	readonly uploads?: {
		readonly source: ContainerSandboxMountSource
		readonly containerPath: string
	}
	readonly scratch?: {
		readonly source: ContainerSandboxMountSource
		readonly containerPath: string
	}
	readonly toolResults?: {
		readonly source: ContainerSandboxMountSource
		readonly containerPath: string
	}
	readonly skills?: readonly {
		readonly id: string
		readonly source: ContainerSandboxMountSource
		readonly containerPath: string
	}[]
	readonly transcripts?: {
		readonly source: ContainerSandboxMountSource
		readonly containerPath: string
	}
}

// ---------------------------------------------------------------------------
// Sandbox create config
// ---------------------------------------------------------------------------

export interface SandboxCreateConfig {
	readonly workingDirectory?: string
	readonly env?: Record<string, string>
	readonly timeoutMs?: number
	readonly memoryLimitMb?: number
	readonly maxProcesses?: number
}

/**
 * Tier-specific layout types ({@link ContainerSandboxLayout}, future
 * `MicroVMSandboxLayout`, etc.) are intentionally NOT fields on
 * {@link SandboxCreateConfig}. The layout is per-task — different
 * `hostPath`s for different runs — but it is supplied at
 * **provider construction**, not at `provider.create()`. See
 * `@namzu/sandbox`'s `createSandboxProvider({ backend, layout })`.
 * Putting layout on `SandboxCreateConfig` would let the SDK runtime
 * (`drainQuery`) call `provider.create()` without it and trigger a
 * runtime validation failure that the type system cannot catch — a
 * trap flagged in the second review round. Hosts spawning a
 * sandbox per task construct one provider per task too; the same
 * closure that knows the per-task `hostPath`s is the one that calls
 * `createSandboxProvider`.
 */

// ---------------------------------------------------------------------------
// SandboxProvider interface — mirrors LLMProvider
// ---------------------------------------------------------------------------

export interface SandboxProvider {
	readonly id: string
	readonly name: string
	readonly environment: SandboxEnvironment
	create(config?: SandboxCreateConfig): Promise<Sandbox>
}

// ---------------------------------------------------------------------------
// Runtime config schema
// ---------------------------------------------------------------------------

export const SandboxConfigSchema = z.object({
	enabled: z.boolean().default(false),
	provider: z.enum(['local']).default('local'),
	timeoutMs: z.number().positive().default(SANDBOX_DEFAULT_TIMEOUT_MS),
	memoryLimitMb: z.number().positive().default(SANDBOX_DEFAULT_MEMORY_LIMIT_MB),
	maxProcesses: z.number().positive().default(SANDBOX_DEFAULT_MAX_PROCESSES),
	/**
	 * Controls the run depends on. Provider construction throws when the
	 * host cannot enforce one of them. Empty by default, which keeps
	 * best-effort behaviour for callers that never asked for a guarantee —
	 * but a caller that did ask now gets it or gets an error, never a
	 * quiet downgrade.
	 */
	requireIsolation: z.array(z.enum(['filesystem', 'network', 'process'])).default([]),
	/**
	 * What the sandbox is rooted at.
	 *
	 * `'ephemeral'` (the default, and the previous and only behaviour) gives
	 * the run a fresh temp directory. Nothing the agent writes touches the
	 * caller's files, and nothing the caller has is visible to it.
	 *
	 * `'working-directory'` roots it at the run's own `workingDirectory`, so
	 * a sandboxed `bash` acts on the project the agent was asked about
	 * instead of on an empty directory. That is the case the sandbox was
	 * wanted for and the one it could not do: the field existed on
	 * `SandboxCreateConfig` and the kernel never set it, so configuring a
	 * sandbox through `runConfig.sandbox` always got a temp directory
	 * whatever the run's own cwd was.
	 *
	 * The trade is the point of naming it rather than inferring it. Rooted
	 * at the working directory, confinement still bounds the agent to that
	 * subtree — but the subtree is now the caller's real files, and a
	 * destructive command inside it is destructive for real.
	 */
	workspace: z.enum(['ephemeral', 'working-directory']).default('ephemeral'),
})

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>
