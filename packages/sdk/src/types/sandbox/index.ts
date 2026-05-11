import { z } from 'zod'
import {
	SANDBOX_DEFAULT_MAX_PROCESSES,
	SANDBOX_DEFAULT_MEMORY_LIMIT_MB,
	SANDBOX_DEFAULT_TIMEOUT_MS,
} from '../../constants/sandbox/index.js'
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

export type SandboxEnvironment = 'linux-namespace' | 'macos-seatbelt' | 'basic'

export function assertSandboxEnvironment(env: SandboxEnvironment): void {
	switch (env) {
		case 'linux-namespace':
		case 'macos-seatbelt':
		case 'basic':
			return
		default: {
			const _exhaustive: never = env
			throw new Error(`Unknown SandboxEnvironment: ${_exhaustive}`)
		}
	}
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
}

// ---------------------------------------------------------------------------
// Exec options
// ---------------------------------------------------------------------------

export interface SandboxExecOptions {
	readonly timeout?: number
	readonly env?: Record<string, string>
	readonly cwd?: string
}

// ---------------------------------------------------------------------------
// Sandbox interface — the core abstraction
// ---------------------------------------------------------------------------

export interface Sandbox {
	readonly id: SandboxId
	readonly status: SandboxStatus
	readonly rootDir: string
	readonly environment: SandboxEnvironment
	exec(command: string, args?: string[], opts?: SandboxExecOptions): Promise<SandboxExecResult>
	writeFile(path: string, content: string | Buffer): Promise<void>
	readFile(path: string): Promise<Buffer>
	destroy(): Promise<void>
}

// ---------------------------------------------------------------------------
// Container sandbox layout — multi-mount taxonomy (container-tier specific)
// ---------------------------------------------------------------------------
//
// Why the `Container` prefix on these types: the layout shape encodes
// container-tier semantics (bind-mount sources, `/mnt/...` container
// paths, RW outputs surface). MicroVM tiers (e2b, fly-machines,
// firecracker-containerd) carry layout-equivalent state that does
// not map onto bind-mount flags — managed snapshots, attached
// volumes, registry-pulled rootfs. Naming the public type
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
 * Declarative multi-mount taxonomy for a CONTAINER sandbox. Mirrors
 * the layout Anthropic's container architecture exposes to the model
 * (Claude container blueprint, Code Interpreter, "skills"):
 *
 *  - `outputs` — RW bind. Deliverables surface the user actually
 *    consumes after the run. Default container path
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
	 * not a child of it: the deliverables collector / output watcher
	 * scans `outputs` only, so anything the agent writes under
	 * `scratch` is invisible to the user by construction. Mirrors the
	 * Anthropic Cowork pattern (`/home/claude` as scratch vs.
	 * `/mnt/user-data/outputs` as the user-visible deliverables area).
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
 * trap Codex flagged in the second review round. Hosts spawning a
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
	cleanupOnDestroy: z.boolean().default(true),
})

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>
