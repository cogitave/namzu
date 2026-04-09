import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { LocalExecutionContextConfig } from '../types/connector/index.js'
import type {
	CommandExecutor,
	CommandOptions,
	CommandResult,
	ExecutionCapability,
	ExecutionEnvironment,
} from '../types/execution/index.js'
import { BaseExecutionContext } from './base.js'

export interface LocalExecutionContextOptions {
	id: string
	cwd: string
	fsAccess?: boolean
	envVars?: Record<string, string>
	capabilities?: ExecutionCapability[]
	shell?: string
}

export class LocalExecutionContext extends BaseExecutionContext implements CommandExecutor {
	readonly id: string
	readonly environment: ExecutionEnvironment = 'local'

	private cwd: string
	private fsAccess: boolean
	private envVars: Record<string, string>
	private capabilities: ExecutionCapability[]
	private shell: string | undefined

	constructor(options: LocalExecutionContextOptions) {
		super()
		this.id = options.id
		this.cwd = resolve(options.cwd)
		this.fsAccess = options.fsAccess ?? true
		this.envVars = options.envVars ?? {}
		this.capabilities = options.capabilities ?? ['filesystem', 'process', 'shell']
		this.shell = options.shell
	}

	protected async doInitialize(): Promise<void> {
		if (!existsSync(this.cwd)) {
			throw new Error(`Working directory does not exist: ${this.cwd}`)
		}
		this.log.info(`Local context initialized at ${this.cwd}`)
	}

	protected async doTeardown(): Promise<void> {}

	getCwd(): string {
		return this.cwd
	}

	setCwd(newCwd: string): void {
		const resolved = resolve(newCwd)
		if (!existsSync(resolved)) {
			throw new Error(`Working directory does not exist: ${resolved}`)
		}
		this.cwd = resolved
	}

	hasFsAccess(): boolean {
		return this.fsAccess
	}

	resolvePath(relativePath: string): string {
		return resolve(this.cwd, relativePath)
	}

	getEnvVar(key: string): string | undefined {
		return this.envVars[key] ?? process.env[key]
	}

	getEnvVars(): Record<string, string> {
		return { ...this.envVars }
	}

	getCapabilities(): ExecutionCapability[] {
		return [...this.capabilities]
	}

	hasCapability(cap: ExecutionCapability): boolean {
		return this.capabilities.includes(cap)
	}

	async executeCommand(
		command: string,
		args: string[] = [],
		options?: CommandOptions,
	): Promise<CommandResult> {
		if (!this.hasCapability('process') && !this.hasCapability('shell')) {
			return {
				exitCode: 1,
				stdout: '',
				stderr: 'Command execution not available: context lacks process/shell capability',
				durationMs: 0,
			}
		}

		const cwd = options?.cwd ? resolve(this.cwd, options.cwd) : this.cwd
		const env = { ...process.env, ...this.envVars, ...options?.env }
		const timeoutMs = options?.timeoutMs ?? 30_000
		const shell = options?.shell ?? this.shell ?? true

		return new Promise<CommandResult>((resolvePromise) => {
			const start = performance.now()
			const proc = spawn(command, args, {
				cwd,
				env,
				shell,
				timeout: timeoutMs,
			})

			let stdout = ''
			let stderr = ''

			proc.stdout?.on('data', (data: Buffer) => {
				stdout += data.toString()
			})

			proc.stderr?.on('data', (data: Buffer) => {
				stderr += data.toString()
			})

			proc.on('close', (code) => {
				resolvePromise({
					exitCode: code ?? 1,
					stdout,
					stderr,
					durationMs: Math.round(performance.now() - start),
				})
			})

			proc.on('error', (err) => {
				resolvePromise({
					exitCode: 1,
					stdout,
					stderr: err.message,
					durationMs: Math.round(performance.now() - start),
				})
			})
		})
	}

	toConfig(): LocalExecutionContextConfig {
		return {
			id: this.id,
			environment: 'local',
			cwd: this.cwd,
			fsAccess: this.fsAccess,
			envVars: this.envVars,
			capabilities: this.capabilities,
			shell: this.shell,
		}
	}
}
