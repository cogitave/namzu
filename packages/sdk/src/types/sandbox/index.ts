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
// Sandbox create config
// ---------------------------------------------------------------------------

export interface SandboxCreateConfig {
	readonly workingDirectory?: string
	readonly env?: Record<string, string>
	readonly timeoutMs?: number
	readonly memoryLimitMb?: number
	readonly maxProcesses?: number
	/**
	 * Optional host-side directory the backend should bind into the
	 * container as the workspace. When unset, container backends
	 * mkdtemp under the OS tmpdir and own the cleanup. When set, the
	 * SDK consumer owns the dir lifecycle. Required when the consumer
	 * is itself a container (e.g. Vandal's app container) asking the
	 * host's Docker daemon to spawn a sibling — the daemon resolves
	 * bind sources against the host filesystem, not the consumer's.
	 */
	readonly hostWorkspaceDir?: string
}

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
