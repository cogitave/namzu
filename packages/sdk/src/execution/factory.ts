import type { ExecutionContextConfig } from '../types/connector/index.js'
import type { BaseExecutionContext } from './base.js'
import { HybridExecutionContext, type HybridExecutionContextOptions } from './hybrid.js'
import { LocalExecutionContext, type LocalExecutionContextOptions } from './local.js'
import { RemoteExecutionContext, type RemoteExecutionContextOptions } from './remote.js'

export class ExecutionContextFactory {
	static create(config: ExecutionContextConfig): BaseExecutionContext {
		switch (config.environment) {
			case 'local':
				return ExecutionContextFactory.createLocal({
					id: config.id,
					cwd: config.cwd,
					fsAccess: config.fsAccess,
					envVars: config.envVars,
					capabilities: config.capabilities,
					shell: config.shell,
				})

			case 'remote':
				return ExecutionContextFactory.createRemote({
					id: config.id,
					target: config.target,
					capabilities: config.capabilities,
				})

			case 'hybrid':
				return ExecutionContextFactory.createHybrid({
					id: config.id,
					local: config.local,
					remotes: config.remotes,
					routingStrategy: config.routingStrategy,
				})

			default: {
				const _exhaustive: never = config
				throw new Error(`Unhandled execution environment: ${JSON.stringify(_exhaustive)}`)
			}
		}
	}

	static createLocal(options: LocalExecutionContextOptions): LocalExecutionContext {
		return new LocalExecutionContext(options)
	}

	static createRemote(options: RemoteExecutionContextOptions): RemoteExecutionContext {
		return new RemoteExecutionContext(options)
	}

	static createHybrid(options: HybridExecutionContextOptions): HybridExecutionContext {
		return new HybridExecutionContext(options)
	}
}
