import type {
	ExecutionContextBase,
	ExecutionContextEvent,
	ExecutionRoutingStrategy,
} from '../execution/index.js'
import type { AuthConfig } from './core.js'

export type {
	ExecutionEnvironment,
	ExecutionCapability,
	ExecutionContextBase,
} from '../execution/index.js'
export type {
	CommandOptions,
	CommandResult,
	CommandExecutor,
	RemoteCommandHandler,
} from '../execution/index.js'
export type { ExecutionRoutingStrategy, ExecutionContextLifecycle } from '../execution/index.js'
export type { ExecutionContextEventListener } from '../execution/index.js'

export interface RemoteTarget {
	type: 'ssh' | 'rdp' | 'api'
	host: string
	port?: number
	auth?: AuthConfig
	metadata?: Record<string, unknown>
}

export interface LocalExecutionContextConfig extends ExecutionContextBase {
	environment: 'local'
	cwd: string
	fsAccess: boolean
	envVars?: Record<string, string>
	shell?: string
}

export interface RemoteExecutionContextConfig extends ExecutionContextBase {
	environment: 'remote'
	target: RemoteTarget
}

export interface HybridExecutionContextConfig extends ExecutionContextBase {
	environment: 'hybrid'
	local: Omit<LocalExecutionContextConfig, 'id' | 'environment'>
	remotes: RemoteTarget[]
	routingStrategy?: ExecutionRoutingStrategy
}

export type ExecutionContextConfig =
	| LocalExecutionContextConfig
	| RemoteExecutionContextConfig
	| HybridExecutionContextConfig

export type ConnectorExecutionContextEvent =
	| ExecutionContextEvent
	| { type: 'remote_connected'; contextId: string; target: RemoteTarget }
	| { type: 'remote_disconnected'; contextId: string; host: string }
