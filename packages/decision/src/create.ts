import type { DecisionModel } from './contract.js'
import { AzureFoundryDecisionModel } from './drivers/azure-foundry.js'
import { HttpDecisionModel } from './drivers/http.js'

/**
 * Azure AI Foundry (hosted Microsoft-Decision-1). The host passes a `getToken`
 * that returns an Entra bearer; this keeps the package free of an Azure SDK,
 * matching how `@namzu/files` and `@namzu/sandbox` take Azure credentials.
 */
export interface AzureDecisionProviderConfig {
	provider: 'azure'
	endpoint: string
	deployment: string
	getToken: () => Promise<string>
	fetch?: typeof fetch
}

/** A local or self-hosted decision server reached over plain HTTP. */
export interface HttpDecisionProviderConfig {
	provider: 'http'
	url: string
	model?: string
	apiKey?: string
	headers?: Record<string, string>
	fetch?: typeof fetch
}

export type DecisionProviderConfig = AzureDecisionProviderConfig | HttpDecisionProviderConfig

/** The provider keys a host may configure. Grows by one case per new driver. */
export type DecisionProvider = DecisionProviderConfig['provider']

/**
 * Build a {@link DecisionModel} from a provider config. One switch, one case
 * per driver — adding a service is a new driver file plus a case here, and the
 * agent-facing side never changes.
 */
export function createDecisionModel(config: DecisionProviderConfig): DecisionModel {
	switch (config.provider) {
		case 'azure':
			return new AzureFoundryDecisionModel({
				endpoint: config.endpoint,
				deployment: config.deployment,
				getToken: config.getToken,
				...(config.fetch ? { fetch: config.fetch } : {}),
			})
		case 'http':
			return new HttpDecisionModel({
				url: config.url,
				...(config.model ? { model: config.model } : {}),
				...(config.apiKey ? { apiKey: config.apiKey } : {}),
				...(config.headers ? { headers: config.headers } : {}),
				...(config.fetch ? { fetch: config.fetch } : {}),
			})
		default: {
			const unknown: never = config
			throw new Error(
				`Unknown decision provider: ${JSON.stringify((unknown as { provider?: unknown }).provider)}`,
			)
		}
	}
}
