import type {
	AuthConfig,
	ConnectorConfig,
	ConnectorScope,
	ResolvedConnectorConfig,
	ScopeChain,
	ScopeRef,
	ScopedConnectorConfig,
} from '../../types/connector/index.js'
import { CONNECTOR_SCOPE_ORDER } from '../../types/connector/index.js'
import type { ConnectorId } from '../../types/ids/index.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

function scopeKey(scope: ConnectorScope, scopeId: string, connectorId: ConnectorId): string {
	return `${scope}:${scopeId}:${connectorId}`
}

export class ScopedConnectorRegistry {
	private configs: Map<string, ScopedConnectorConfig> = new Map()
	private log: Logger

	constructor() {
		this.log = getRootLogger().child({ component: 'ScopedConnectorRegistry' })
	}

	set(config: ScopedConnectorConfig): void {
		const key = scopeKey(config.scope.scope, config.scope.scopeId, config.connectorId)
		this.configs.set(key, config)
		this.log.info(`Scoped config set: ${key}`)
	}

	remove(scope: ScopeRef, connectorId: ConnectorId): boolean {
		const key = scopeKey(scope.scope, scope.scopeId, connectorId)
		const removed = this.configs.delete(key)
		if (removed) {
			this.log.info(`Scoped config removed: ${key}`)
		}
		return removed
	}

	getAt(scope: ScopeRef, connectorId: ConnectorId): ScopedConnectorConfig | undefined {
		return this.configs.get(scopeKey(scope.scope, scope.scopeId, connectorId))
	}

	resolve(connectorId: ConnectorId, chain: ScopeChain): ResolvedConnectorConfig | undefined {
		const layers: ScopedConnectorConfig[] = []

		for (const scope of CONNECTOR_SCOPE_ORDER) {
			const scopeId = chain[scope]
			if (!scopeId) continue

			const config = this.configs.get(scopeKey(scope, scopeId, connectorId))
			if (config) {
				layers.push(config)
			}
		}

		if (layers.length === 0) return undefined

		return this.mergeLayers(connectorId, layers)
	}

	listForConnector(connectorId: ConnectorId): ScopedConnectorConfig[] {
		const results: ScopedConnectorConfig[] = []
		for (const config of this.configs.values()) {
			if (config.connectorId === connectorId) {
				results.push(config)
			}
		}
		return results
	}

	listAtScope(scope: ScopeRef): ScopedConnectorConfig[] {
		const prefix = `${scope.scope}:${scope.scopeId}:`
		const results: ScopedConnectorConfig[] = []
		for (const [key, config] of this.configs.entries()) {
			if (key.startsWith(prefix)) {
				results.push(config)
			}
		}
		return results
	}

	private mergeLayers(
		connectorId: ConnectorId,
		layers: ScopedConnectorConfig[],
	): ResolvedConnectorConfig {
		let mergedOptions: Record<string, unknown> = {}
		let mergedAuth: AuthConfig | undefined
		let mergedEnabled = true
		let mergedPartialConfig: Partial<ConnectorConfig> = {}
		const resolvedFrom: ScopeRef[] = []

		for (const layer of layers) {
			resolvedFrom.push(layer.scope)

			if (layer.options) {
				mergedOptions = { ...mergedOptions, ...layer.options }
			}

			if (layer.auth !== undefined) {
				mergedAuth = layer.auth
			}

			if (layer.enabled !== undefined) {
				mergedEnabled = layer.enabled
			}

			if (layer.config) {
				mergedPartialConfig = { ...mergedPartialConfig, ...layer.config }
			}
		}

		const config: ConnectorConfig = {
			connectorId,
			name: mergedPartialConfig.name ?? connectorId,
			auth: mergedAuth ?? mergedPartialConfig.auth,
			options: mergedOptions,
		}

		return {
			connectorId,
			config,
			auth: mergedAuth,
			enabled: mergedEnabled,
			options: mergedOptions,
			resolvedFrom,
		}
	}
}
