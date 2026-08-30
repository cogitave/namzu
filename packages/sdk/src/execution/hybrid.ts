import type {
	CommandExecutor,
	CommandOptions,
	CommandResult,
	ExecutionCapability,
	ExecutionEnvironment,
	ExecutionRoutingStrategy,
	HybridExecutionContextConfig,
	RemoteTarget,
} from '../types/connector/index.js'
import type { Logger } from '../utils/logger.js'
import { BaseExecutionContext } from './base.js'
import { LocalExecutionContext } from './local.js'
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
	log?: Logger
}

export class HybridExecutionContext extends BaseExecutionContext implements CommandExecutor {
	readonly id: string
	readonly environment: ExecutionEnvironment = 'hybrid'

	private localCtx: LocalExecutionContext
	private remoteCtxs: Map<string, RemoteExecutionContext> = new Map()
	private remoteTargets: RemoteTarget[]
	private routingStrategy: ExecutionRoutingStrategy
	private roundRobinIndex = 0
	private admissionsOpen = true

	constructor(options: HybridExecutionContextOptions) {
		super(options.log)
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
			log: options.log,
		})

		this.localCtx.on((event) => this.emit(event))

		for (const [i, target] of options.remotes.entries()) {
			const remoteId = `${options.id}_remote_${i}`
			const remote = new RemoteExecutionContext({
				id: remoteId,
				target,
				log: options.log,
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

		this.log.info('Hybrid context initialized', {
			'namzu.execution.local_cwd': this.localCtx.getCwd(),
			'namzu.execution.remote_count': this.remoteCtxs.size,
			'namzu.execution.routing_strategy': this.routingStrategy,
		})
	}

	protected override onInitializationStarted(): void {
		this.admissionsOpen = false
	}

	protected override onInitializationCommitted(): void {
		this.admissionsOpen = true
	}

	protected override onTeardownRequested(): void {
		this.admissionsOpen = false
	}

	protected async doTeardown(): Promise<void> {
		const contexts: BaseExecutionContext[] = [this.localCtx, ...this.remoteCtxs.values()]
		const results = await Promise.allSettled(contexts.map((context) => context.teardown()))
		const failures = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		)

		if (failures.length === 1) throw failures[0]
		if (failures.length > 1) {
			throw new AggregateError(failures, 'Multiple hybrid execution contexts failed to tear down')
		}
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
		const results = await Promise.allSettled(
			Array.from(this.remoteCtxs.values(), (remote) => remote.disconnect()),
		)
		const failures = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		)
		if (failures.length === 1) throw failures[0]
		if (failures.length > 1) {
			throw new AggregateError(failures, 'Multiple remote execution contexts failed to disconnect')
		}
	}

	async executeCommand(
		command: string,
		args: string[] = [],
		options?: CommandOptions,
	): Promise<CommandResult> {
		if (!this.admissionsOpen) {
			throw new Error(
				`Hybrid execution context "${this.id}" is initializing, tearing down, or torn down. Wait for initialization to commit before executing another command.`,
			)
		}
		switch (this.routingStrategy) {
			case 'local-first':
				return this.localCtx.executeCommand(command, args, options)

			case 'remote-first': {
				const connectedRemote = this.getFirstConnectedRemote()
				if (connectedRemote) {
					return connectedRemote.executeCommand(command, args, options)
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
				const target = targets[targetIndex]
				if (target === undefined) {
					return this.localCtx.executeCommand(command, args, options)
				}

				if (target === this.localCtx) {
					return this.localCtx.executeCommand(command, args, options)
				}
				return (target as RemoteExecutionContext).executeCommand(command, args, options)
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
