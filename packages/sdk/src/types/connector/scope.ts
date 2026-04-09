import type { AuthConfig } from './core.js'
import type { ConnectorConfig } from './definition.js'

export type ConnectorScope = 'org' | 'environment' | 'team' | 'project' | 'agent'

export const CONNECTOR_SCOPE_ORDER: readonly ConnectorScope[] = [
	'org',
	'environment',
	'team',
	'project',
	'agent',
] as const

export interface ScopeRef {
	scope: ConnectorScope
	scopeId: string
}

export interface ScopedConnectorConfig {
	scope: ScopeRef
	connectorId: string

	config?: Partial<ConnectorConfig>

	auth?: AuthConfig

	enabled?: boolean

	options?: Record<string, unknown>
}

export interface ResolvedConnectorConfig {
	connectorId: string
	config: ConnectorConfig
	auth?: AuthConfig
	enabled: boolean
	options: Record<string, unknown>

	resolvedFrom: ScopeRef[]
}

export type ScopeChain = Partial<Record<ConnectorScope, string>>
