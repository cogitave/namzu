import type {
	CommandExecutor,
	CommandOptions,
	CommandResult,
	ExecutionCapability,
	ExecutionEnvironment,
	RemoteCommandHandler,
	RemoteExecutionContextConfig,
	RemoteTarget,
} from '../types/connector/index.js'
import type { Logger } from '../utils/logger.js'
import { BaseExecutionContext } from './base.js'
import { CommandCancellationUnsupportedError, RemoteExecutionBusyError } from './errors.js'

export interface RemoteExecutionContextOptions {
	id: string
	target: RemoteTarget
	capabilities?: ExecutionCapability[]
	/**
	 * Executes a command while preserving its argument boundaries at Namzu's
	 * remote seam. A downstream executor may still interpret `shell` according
	 * to its own target.
	 */
	commandExecutor?: CommandExecutor
	/** @deprecated Use `commandExecutor`. */
	commandHandler?: RemoteCommandHandler
	log?: Logger
}

export class RemoteExecutionContext extends BaseExecutionContext implements CommandExecutor {
	readonly id: string
	readonly environment: ExecutionEnvironment = 'remote'

	private target: RemoteTarget
	private connected = false
	private capabilities: ExecutionCapability[]
	private commandExecutor: CommandExecutor | undefined
	private commandHandler: RemoteCommandHandler | undefined
	private lifecycleAdmissionsOpen = true
	private readonly activeCommands = new Set<symbol>()

	constructor(options: RemoteExecutionContextOptions) {
		super(options.log)
		this.id = options.id
		this.target = options.target
		this.capabilities = options.capabilities ?? ['network']
		this.commandExecutor = options.commandExecutor
		this.commandHandler = options.commandHandler
	}

	protected async doInitialize(): Promise<void> {
		this.validateTarget(this.target)
		this.log.info('Remote context initialized', {
			'namzu.execution.target_type': this.target.type,
			'namzu.execution.target_host': this.target.host,
		})
	}

	protected override onInitializationStarted(): void {
		this.lifecycleAdmissionsOpen = false
	}

	protected override onInitializationCommitted(): void {
		this.lifecycleAdmissionsOpen = true
	}

	protected override onTeardownRequested(): void {
		this.lifecycleAdmissionsOpen = false
	}

	protected async doTeardown(): Promise<void> {
		this.assertIdleForDisconnect()
		await this.disconnect()
	}

	async connect(): Promise<void> {
		if (!this.lifecycleAdmissionsOpen) {
			throw new Error(
				`Remote execution context "${this.id}" cannot connect until initialization commits after teardown or failed initialization.`,
			)
		}
		if (this.connected) return
		this.connected = true
		this.emit({
			type: 'remote_connected',
			contextId: this.id,
			target: this.target,
		})
		this.log.info('Remote connected', {
			'namzu.execution.target_type': this.target.type,
			'namzu.execution.target_host': this.target.host,
			'namzu.execution.target_port': this.target.port ?? 'default',
		})
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return
		this.assertIdleForDisconnect()
		this.connected = false
		this.emit({
			type: 'remote_disconnected',
			contextId: this.id,
			host: this.target.host,
		})
		this.log.info('Remote disconnected', { 'namzu.execution.target_host': this.target.host })
	}

	isConnected(): boolean {
		return this.connected
	}

	getTarget(): RemoteTarget {
		return { ...this.target }
	}

	getConnectionString(): string {
		const port = this.target.port ? `:${this.target.port}` : ''
		return `${this.target.type}://${this.target.host}${port}`
	}

	getCapabilities(): ExecutionCapability[] {
		return [...this.capabilities]
	}

	hasCapability(cap: ExecutionCapability): boolean {
		return this.capabilities.includes(cap)
	}

	setCommandExecutor(executor: CommandExecutor): void {
		this.commandExecutor = executor
	}

	/** @deprecated Use `setCommandExecutor()`. */
	setCommandHandler(handler: RemoteCommandHandler): void {
		this.commandHandler = handler
	}

	async executeCommand(
		command: string,
		args: string[] = [],
		options?: CommandOptions,
	): Promise<CommandResult> {
		if (this.commandExecutor) {
			const executor = this.admitCommand(
				this.commandExecutor,
				`No remote command executor configured for context "${this.id}". Set one via setCommandExecutor() before calling executeCommand().`,
			)
			this.assertCancellationUnsupported(options?.signal)
			return this.trackCommand(() => executor.executeCommand(command, args, options))
		}

		const handler = this.admitCommand(
			this.commandHandler,
			`No remote command executor configured for context "${this.id}". Set one via setCommandExecutor() before calling executeCommand().`,
		)
		this.assertCancellationUnsupported(options?.signal)
		const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command
		return this.trackCommand(() => handler.executeRemote(fullCommand, options))
	}

	/**
	 * @deprecated Use `executeCommand()` so command arguments retain their
	 * boundaries at Namzu's remote execution seam.
	 */
	async executeRemote(command: string, options?: CommandOptions): Promise<CommandResult> {
		const handler = this.admitCommand(
			this.commandHandler,
			`No remote command handler configured for context "${this.id}". Set one via setCommandHandler() before calling executeRemote().`,
		)
		this.assertCancellationUnsupported(options?.signal)
		return this.trackCommand(() => handler.executeRemote(command, options))
	}

	toConfig(): RemoteExecutionContextConfig {
		return {
			id: this.id,
			environment: 'remote',
			target: { ...this.target },
			capabilities: this.capabilities,
		}
	}

	private validateTarget(target: RemoteTarget): void {
		if (!target.host) {
			throw new Error('Remote target must have a host')
		}
		if (!['ssh', 'rdp', 'api'].includes(target.type)) {
			throw new Error(`Unsupported remote target type: "${target.type}"`)
		}
	}

	private admitCommand<T>(implementation: T | undefined, missingMessage: string): T {
		if (implementation === undefined) throw new Error(missingMessage)
		if (!this.lifecycleAdmissionsOpen) {
			throw new Error(
				`Remote execution context "${this.id}" is initializing, tearing down, or torn down. Wait for initialization to commit before executing another command.`,
			)
		}
		if (!this.connected) {
			throw new Error(`Remote context "${this.id}" is not connected. Call connect() first.`)
		}
		return implementation
	}

	private assertCancellationUnsupported(signal: AbortSignal | undefined): void {
		if (signal !== undefined) throw new CommandCancellationUnsupportedError(this.id)
	}

	private assertIdleForDisconnect(): void {
		if (this.activeCommands.size > 0) {
			throw new RemoteExecutionBusyError(this.id, this.activeCommands.size)
		}
	}

	private trackCommand(invoke: () => Promise<CommandResult>): Promise<CommandResult> {
		const ownership = Symbol('remote-command')
		this.activeCommands.add(ownership)
		const release = (): void => {
			this.activeCommands.delete(ownership)
		}

		let operation: Promise<CommandResult>
		try {
			operation = Promise.resolve(invoke())
		} catch (error) {
			release()
			return Promise.reject(error)
		}

		return operation.then(
			(result) => {
				release()
				return result
			},
			(error: unknown) => {
				release()
				throw error
			},
		)
	}
}
