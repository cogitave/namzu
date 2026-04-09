import type { z } from 'zod'
import type { ConnectorInstanceId } from '../ids/index.js'

export type ConnectionType = 'http' | 'webhook' | 'custom'

export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export function isConnectorActive(status: ConnectorStatus): boolean {
	return status === 'connected' || status === 'connecting'
}

export type AuthType = 'none' | 'api_key' | 'bearer' | 'basic' | 'oauth2' | 'custom'

export interface AuthConfig {
	type: AuthType
	credentials?: Record<string, string>
}

export type ConnectorCategory =
	| 'communication'
	| 'data'
	| 'development'
	| 'productivity'
	| 'integration'
	| 'custom'

export interface ConnectorMethod<TInput = unknown, TOutput = unknown> {
	name: string
	description: string
	inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>
	outputSchema?: z.ZodType<TOutput, z.ZodTypeDef, unknown>
}

export interface ConnectorTrigger {
	name: string
	description: string
	event: string
	configSchema?: z.ZodType
}

export interface ConnectorEvent {
	connectorId: string
	instanceId: ConnectorInstanceId
	trigger: string
	payload: unknown
	timestamp: number
}
