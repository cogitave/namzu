import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { killTree } from '../process/kill-tree.js'
import type { LocalExecutionContextConfig } from '../types/connector/index.js'
import type {
	CommandExecutor,
	CommandOptions,
	CommandResult,
	ExecutionCapability,
	ExecutionEnvironment,
} from '../types/execution/index.js'
import type { Logger } from '../utils/logger.js'
import { BaseExecutionContext } from './base.js'

const LOCAL_COMMAND_DEFAULT_TIMEOUT_MS = 30_000
const LOCAL_COMMAND_KILL_GRACE_MS = 3_000

type LocalCommandCancellation = 'deadline' | 'teardown'

interface ActiveLocalCommand {
	readonly closed: Promise<void>
	cancel(origin: LocalCommandCancellation): void
}

export interface LocalExecutionContextOptions {
	id: string
	cwd: string
	fsAccess?: boolean
	envVars?: Record<string, string>
	capabilities?: ExecutionCapability[]
	shell?: string
	log?: Logger
}

export class LocalExecutionContext extends BaseExecutionContext implements CommandExecutor {
	readonly id: string
	readonly environment: ExecutionEnvironment = 'local'

	private cwd: string
	private fsAccess: boolean
	private envVars: Record<string, string>
	private capabilities: ExecutionCapability[]
	private shell: string | undefined
	/**
	 * Constructor-created contexts are intentionally executable before
	 * `initialize()`: `createCommandGate()` has always used that public path.
	 * Teardown closes admission synchronously; an explicit initialize reopens it.
	 */
	private acceptsCommands = true
	private readonly activeCommands = new Set<ActiveLocalCommand>()

	constructor(options: LocalExecutionContextOptions) {
		super(options.log)
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
		this.acceptsCommands = true
		this.log.info('Local context initialized', { 'namzu.execution.cwd': this.cwd })
	}

	protected async doTeardown(): Promise<void> {
		// Fence before the first await so a command submitted in the same turn
		// cannot slip behind the teardown snapshot.
		this.acceptsCommands = false
		const admitted = [...this.activeCommands]
		for (const operation of admitted) operation.cancel('teardown')
		await Promise.all(admitted.map((operation) => operation.closed))
	}

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
		if (!this.acceptsCommands) {
			throw new Error(
				`Local execution context "${this.id}" is tearing down or torn down. Call initialize() before executing another command.`,
			)
		}
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
		const timeoutMs = options?.timeoutMs ?? LOCAL_COMMAND_DEFAULT_TIMEOUT_MS
		if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
			throw new RangeError(
				`The value of "timeoutMs" is out of range. It must be an unsigned integer. Received ${timeoutMs}`,
			)
		}
		// node's spawn() only keeps argv separation when it execs the binary directly;
		// with shell enabled it re-joins command+args into one unescaped string and hands
		// it to sh/cmd.exe, so any caller-supplied arg becomes shell syntax rather than a
		// literal value. Since `command`/`args` here are whatever a tool call passed in,
		// shell interpretation must be an explicit opt-in, never the silent default.
		const shell = options?.shell ?? this.shell ?? false

		let operation: ActiveLocalCommand
		const result = new Promise<CommandResult>((resolvePromise) => {
			const start = performance.now()
			const proc = spawn(command, args, {
				cwd,
				env,
				shell,
				// POSIX process-group ownership is the strongest boundary available
				// to this host execution context. Windows uses taskkill /T in
				// `killTree`; neither path relies on Node's direct-child timeout.
				detached: process.platform !== 'win32',
			})

			let stdout = ''
			let stderr = ''
			let spawnError: Error | undefined
			let cancellation: LocalCommandCancellation | undefined
			let escalation: ReturnType<typeof setTimeout> | undefined
			let deadline: ReturnType<typeof setTimeout> | undefined
			let settled = false

			const terminate = (signal: NodeJS.Signals): void => {
				killTree(proc, signal)
			}
			const cancel = (origin: LocalCommandCancellation): void => {
				if (settled || cancellation !== undefined) return
				cancellation = origin
				terminate('SIGTERM')
				escalation = setTimeout(() => {
					escalation = undefined
					terminate('SIGKILL')
				}, LOCAL_COMMAND_KILL_GRACE_MS)
				escalation.unref?.()
			}

			let resolveClosed: (() => void) | undefined
			const closed = new Promise<void>((resolveClose) => {
				resolveClosed = resolveClose
			})
			operation = { cancel, closed }
			this.activeCommands.add(operation)

			if (timeoutMs > 0) {
				deadline = setTimeout(() => cancel('deadline'), timeoutMs)
				deadline.unref?.()
			}

			proc.stdout?.on('data', (data: Buffer) => {
				stdout += data.toString()
			})

			proc.stderr?.on('data', (data: Buffer) => {
				stderr += data.toString()
			})

			proc.once('error', (err) => {
				// `close` follows `error` and is the point at which inherited stdio
				// has drained. Releasing ownership here would strand a descendant
				// which still holds those descriptors.
				spawnError = err
			})

			proc.once('close', (code) => {
				if (settled) return
				settled = true
				if (deadline !== undefined) clearTimeout(deadline)
				if (escalation !== undefined) {
					clearTimeout(escalation)
					escalation = undefined
					// Do not retain a numeric process-group id for a later timer after
					// close: the host can reuse it. Force the cancellation boundary now.
					terminate('SIGKILL')
				}
				this.activeCommands.delete(operation)
				resolveClosed?.()
				resolvePromise({
					exitCode: spawnError === undefined ? (code ?? 1) : 1,
					stdout,
					stderr: spawnError?.message ?? stderr,
					durationMs: Math.round(performance.now() - start),
				})
			})
		})
		return result
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
