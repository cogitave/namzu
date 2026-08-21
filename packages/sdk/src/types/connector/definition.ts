import type { z } from 'zod'
import type { ConnectorId, ConnectorInstanceId } from '../ids/index.js'
import type {
	AuthConfig,
	AuthType,
	ConnectionType,
	ConnectorCategory,
	ConnectorMethod,
	ConnectorStatus,
	ConnectorTrigger,
} from './core.js'

export interface ConnectorDefinition<TConfig = unknown> {
	id: ConnectorId
	name: string
	description: string
	version?: string
	category?: ConnectorCategory
	connectionType: ConnectionType
	/**
	 * Authentication schemes this connector can consume. When present, the
	 * manager refuses an unsupported explicit credential before publishing an
	 * instance and revalidates the effective scheme immediately before connect.
	 * Omit only when a custom connector intentionally accepts every scheme.
	 */
	supportedAuth?: readonly AuthType[]
	configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>
	methods: ConnectorMethod[]
	/** Declared, not implemented — see {@link ConnectorTrigger}. */
	triggers?: ConnectorTrigger[]
}

export interface ConnectorConfig {
	readonly connectorId: ConnectorId
	name: string
	auth?: AuthConfig
	options?: Record<string, unknown>
}

export interface ConnectorInstance {
	readonly id: ConnectorInstanceId
	readonly connectorId: ConnectorId
	readonly config: ConnectorConfig
	status: ConnectorStatus
	readonly createdAt: number
	connectedAt?: number
	lastUsedAt?: number
	error?: string
}

/** What the client can establish about a connector side effect. */
export type ConnectorRemoteOutcome = 'not_started' | 'unknown' | 'response_received'

/** Whether repeating the connector call can be recommended without duplicating a side effect. */
export type ConnectorRetrySafety = 'safe' | 'unsafe' | 'unknown'

export interface ConnectorOperationOptions {
	/** The authority for this operation. A pre-aborted signal starts no connector work. */
	signal?: AbortSignal
}

export interface ConnectorExecutionMetadata extends Record<string, unknown> {
	remoteOutcome?: ConnectorRemoteOutcome
	retrySafety?: ConnectorRetrySafety
	bodyAvailable?: boolean
}

export interface ConnectorExecuteParams extends ConnectorOperationOptions {
	instanceId: ConnectorInstanceId
	method: string
	input: unknown
}

export interface ConnectorExecuteResult {
	success: boolean
	output: unknown
	error?: string
	durationMs: number
	metadata?: ConnectorExecutionMetadata
}

export interface ConnectorLifecycle<TConfig = unknown> {
	connect(config: TConfig, auth?: AuthConfig): Promise<void>
	disconnect(): Promise<void>
	healthCheck(options?: ConnectorOperationOptions): Promise<boolean>
	execute(
		method: string,
		/** ConnectorManager supplies the method schema's parsed canonical value on managed calls. */
		input: unknown,
		options?: ConnectorOperationOptions,
	): Promise<ConnectorExecuteResult>
}

export type ConnectorLifecycleEvent =
	| { type: 'connector_registered'; connectorId: ConnectorId }
	| { type: 'connector_unregistered'; connectorId: ConnectorId }
	| {
			type: 'instance_created'
			instanceId: ConnectorInstanceId
			connectorId: ConnectorId
	  }
	| { type: 'instance_connecting'; instanceId: ConnectorInstanceId }
	| { type: 'instance_connected'; instanceId: ConnectorInstanceId }
	| { type: 'instance_disconnected'; instanceId: ConnectorInstanceId }
	| { type: 'instance_error'; instanceId: ConnectorInstanceId; error: string }
	| { type: 'instance_removed'; instanceId: ConnectorInstanceId }
	| {
			type: 'action_executing'
			instanceId: ConnectorInstanceId
			method: string
	  }
	| {
			type: 'action_completed'
			instanceId: ConnectorInstanceId
			method: string
			success: boolean
			durationMs: number
	  }

export type ConnectorEventListener = (event: ConnectorLifecycleEvent) => void
