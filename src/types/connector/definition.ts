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
	supportedAuth?: AuthType[]
	configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>
	methods: ConnectorMethod[]
	triggers?: ConnectorTrigger[]
}

export interface ConnectorConfig {
	connectorId: ConnectorId
	name: string
	auth?: AuthConfig
	options?: Record<string, unknown>
}

export interface ConnectorInstance {
	id: ConnectorInstanceId
	connectorId: ConnectorId
	config: ConnectorConfig
	status: ConnectorStatus
	createdAt: number
	connectedAt?: number
	lastUsedAt?: number
	error?: string
}

export interface ConnectorExecuteParams {
	instanceId: ConnectorInstanceId
	method: string
	input: unknown
}

export interface ConnectorExecuteResult {
	success: boolean
	output: unknown
	error?: string
	durationMs: number
	metadata?: Record<string, unknown>
}

export interface ConnectorLifecycle<TConfig = unknown> {
	connect(config: TConfig, auth?: AuthConfig): Promise<void>
	disconnect(): Promise<void>
	healthCheck(): Promise<boolean>
	execute(method: string, input: unknown): Promise<ConnectorExecuteResult>
}

export type ConnectorLifecycleEvent =
	| { type: 'connector_registered'; connectorId: ConnectorId }
	| { type: 'connector_unregistered'; connectorId: ConnectorId }
	| { type: 'instance_created'; instanceId: ConnectorInstanceId; connectorId: ConnectorId }
	| { type: 'instance_connecting'; instanceId: ConnectorInstanceId }
	| { type: 'instance_connected'; instanceId: ConnectorInstanceId }
	| { type: 'instance_disconnected'; instanceId: ConnectorInstanceId }
	| { type: 'instance_error'; instanceId: ConnectorInstanceId; error: string }
	| { type: 'instance_removed'; instanceId: ConnectorInstanceId }
	| { type: 'action_executing'; instanceId: ConnectorInstanceId; method: string }
	| {
			type: 'action_completed'
			instanceId: ConnectorInstanceId
			method: string
			success: boolean
			durationMs: number
	  }

export type ConnectorEventListener = (event: ConnectorLifecycleEvent) => void
