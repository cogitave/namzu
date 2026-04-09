import { BaseExecutionContext } from '../../execution/base.js'
import type {
	CommandOptions,
	CommandResult,
	ExecutionCapability,
	ExecutionEnvironment,
	RemoteCommandHandler,
	RemoteExecutionContextConfig,
	RemoteTarget,
} from '../../types/connector/index.js'

export interface RemoteExecutionContextOptions {
	id: string
	target: RemoteTarget
	capabilities?: ExecutionCapability[]
	commandHandler?: RemoteCommandHandler
}

export class RemoteExecutionContext extends BaseExecutionContext {
	readonly id: string
	readonly environment: ExecutionEnvironment = 'remote'

	private target: RemoteTarget
	private connected = false
	private capabilities: ExecutionCapability[]
	private commandHandler: RemoteCommandHandler | undefined

	constructor(options: RemoteExecutionContextOptions) {
		super()
		this.id = options.id
		this.target = options.target
		this.capabilities = options.capabilities ?? ['network']
		this.commandHandler = options.commandHandler
	}

	protected async doInitialize(): Promise<void> {
		this.validateTarget(this.target)
		this.log.info(`Remote context initialized for ${this.target.type}://${this.target.host}`)
	}

	protected async doTeardown(): Promise<void> {
		if (this.connected) {
			this.connected = false
			this.emit({
				type: 'remote_disconnected',
				contextId: this.id,
				host: this.target.host,
			})
		}
	}

	async connect(): Promise<void> {
		this.connected = true
		this.emit({
			type: 'remote_connected',
			contextId: this.id,
			target: this.target,
		})
		this.log.info(
			`Remote connected: ${this.target.type}://${this.target.host}:${this.target.port ?? 'default'}`,
		)
	}

	async disconnect(): Promise<void> {
		if (!this.connected) return
		this.connected = false
		this.emit({
			type: 'remote_disconnected',
			contextId: this.id,
			host: this.target.host,
		})
		this.log.info(`Remote disconnected: ${this.target.host}`)
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

	setCommandHandler(handler: RemoteCommandHandler): void {
		this.commandHandler = handler
	}

	async executeRemote(command: string, options?: CommandOptions): Promise<CommandResult> {
		if (!this.commandHandler) {
			throw new Error(
				`No remote command handler configured for context "${this.id}". Set one via setCommandHandler() before calling executeRemote().`,
			)
		}
		if (!this.connected) {
			throw new Error(`Remote context "${this.id}" is not connected. Call connect() first.`)
		}
		return this.commandHandler.executeRemote(command, options)
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
}
