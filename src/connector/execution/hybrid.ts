import { BaseExecutionContext } from '../../execution/base.js'
import { LocalExecutionContext } from '../../execution/local.js'
import type {
	CommandExecutor,
	CommandOptions,
	CommandResult,
	ExecutionCapability,
	ExecutionEnvironment,
	ExecutionRoutingStrategy,
	HybridExecutionContextConfig,
	RemoteTarget,
} from '../../types/connector/index.js'
import { RemoteExecutionContext } from './remote.js'

export interface HybridExecutionContextOptions {
	id: string
	local: {
		cwd: string
		fsAccess?: boolean
		envVars?: Record<string, string>
		capabilities?: ExecutionCapability[]
		shell?: string
	}
	remotes: RemoteTarget[]
	routingStrategy?: ExecutionRoutingStrategy
}

export class HybridExecutionContext extends BaseExecutionContext implements CommandExecutor {
	readonly id: string
	readonly environment: ExecutionEnvironment = 'hybrid'

	private localCtx: LocalExecutionContext
	private remoteCtxs: Map<string, RemoteExecutionContext> = new Map()
	private remoteTargets: RemoteTarget[]
	private routingStrategy: ExecutionRoutingStrategy
	private roundRobinIndex = 0

	constructor(options: HybridExecutionContextOptions) {
		super()
		this.id = options.id
		this.remoteTargets = options.remotes
		this.routingStrategy = options.routingStrategy ?? 'local-first'

		this.localCtx = new LocalExecutionContext({
			id: `${options.id}_local`,
			cwd: options.local.cwd,
			fsAccess: options.local.fsAccess,
			envVars: options.local.envVars,
			capabilities: options.local.capabilities,
			shell: options.local.shell,
		})

		this.localCtx.on((event) => this.emit(event))

		for (let i = 0; i < options.remotes.length; i++) {
			const target = options.remotes[i]!
			const remoteId = `${options.id}_remote_${i}`
			const remote = new RemoteExecutionContext({
				id: remoteId,
				target,
			})
			remote.on((event) => this.emit(event))
			this.remoteCtxs.set(remoteId, remote)
		}
	}

	protected async doInitialize(): Promise<void> {
		await this.localCtx.initialize()

		const initPromises: Promise<void>[] = []
		for (const remote of this.remoteCtxs.values()) {
			initPromises.push(remote.initialize())
		}
		await Promise.all(initPromises)

		this.log.info(
			`Hybrid context initialized: local(${this.localCtx.getCwd()}) + ${this.remoteCtxs.size} remote(s), strategy=${this.routingStrategy}`,
		)
	}

	protected async doTeardown(): Promise<void> {
		const teardownPromises: Promise<void>[] = []
		for (const remote of this.remoteCtxs.values()) {
			teardownPromises.push(remote.teardown())
		}
		await Promise.allSettled(teardownPromises)
		await this.localCtx.teardown()
	}

	getLocal(): LocalExecutionContext {
		return this.localCtx
	}

	getRemote(remoteId: string): RemoteExecutionContext | undefined {
		return this.remoteCtxs.get(remoteId)
	}

	getRemotes(): RemoteExecutionContext[] {
		return Array.from(this.remoteCtxs.values())
	}

	getRoutingStrategy(): ExecutionRoutingStrategy {
		return this.routingStrategy
	}

	setRoutingStrategy(strategy: ExecutionRoutingStrategy): void {
		this.routingStrategy = strategy
		this.roundRobinIndex = 0
	}

	async connectAllRemotes(): Promise<void> {
		const promises: Promise<void>[] = []
		for (const remote of this.remoteCtxs.values()) {
			promises.push(remote.connect())
		}
		await Promise.all(promises)
	}

	async disconnectAllRemotes(): Promise<void> {
		const promises: Promise<void>[] = []
		for (const remote of this.remoteCtxs.values()) {
			promises.push(remote.disconnect())
		}
		await Promise.allSettled(promises)
	}

	async executeCommand(
		command: string,
		args: string[] = [],
		options?: CommandOptions,
	): Promise<CommandResult> {
		switch (this.routingStrategy) {
			case 'local-first':
				return this.localCtx.executeCommand(command, args, options)

			case 'remote-first': {
				const connectedRemote = this.getFirstConnectedRemote()
				if (connectedRemote) {
					const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command
					return connectedRemote.executeRemote(fullCommand, options)
				}
				return this.localCtx.executeCommand(command, args, options)
			}

			case 'round-robin': {
				const targets = this.getRoundRobinTargets()
				if (targets.length === 0) {
					return this.localCtx.executeCommand(command, args, options)
				}
				const targetIndex = this.roundRobinIndex % targets.length
				this.roundRobinIndex++
				const target = targets[targetIndex]!

				if (target === this.localCtx) {
					return this.localCtx.executeCommand(command, args, options)
				}
				const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command
				return (target as RemoteExecutionContext).executeRemote(fullCommand, options)
			}

			default: {
				const _exhaustive: never = this.routingStrategy
				throw new Error(`Unhandled routing strategy: ${_exhaustive}`)
			}
		}
	}

	toConfig(): HybridExecutionContextConfig {
		return {
			id: this.id,
			environment: 'hybrid',
			local: {
				cwd: this.localCtx.getCwd(),
				fsAccess: this.localCtx.hasFsAccess(),
				envVars: this.localCtx.getEnvVars(),
			},
			remotes: this.remoteTargets.map((t) => ({ ...t })),
			routingStrategy: this.routingStrategy,
		}
	}

	private getFirstConnectedRemote(): RemoteExecutionContext | undefined {
		for (const remote of this.remoteCtxs.values()) {
			if (remote.isConnected()) {
				return remote
			}
		}
		return undefined
	}

	private getRoundRobinTargets(): (LocalExecutionContext | RemoteExecutionContext)[] {
		const targets: (LocalExecutionContext | RemoteExecutionContext)[] = [this.localCtx]
		for (const remote of this.remoteCtxs.values()) {
			if (remote.isConnected()) {
				targets.push(remote)
			}
		}
		return targets
	}
}
