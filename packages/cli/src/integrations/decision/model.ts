import {
	type DecisionProviderConfig,
	createDecisionModel,
	createDecisionTool,
} from '@namzu/decision'
import type { ToolDefinition } from '@namzu/sdk'
import type { DecisionConfig } from '../../config/schema.js'

/**
 * Map the declarative `decision` config block plus the environment to the
 * package's provider config. The config names the variable that holds a
 * credential; the value is read here, at call time, never stored.
 *
 * A real credential resolver (`az`, managed identity) is a deliberate future
 * seam: `getToken` is where it plugs in.
 */
export function buildDecisionProviderConfig(
	cfg: DecisionConfig,
	env: NodeJS.ProcessEnv,
): DecisionProviderConfig {
	if (cfg.provider === 'azure') {
		return {
			provider: 'azure',
			endpoint: cfg.endpoint,
			deployment: cfg.deployment,
			getToken: async () => env[cfg.tokenEnv ?? 'AZURE_FOUNDRY_TOKEN'] ?? '',
		}
	}
	return {
		provider: 'http',
		url: cfg.url,
		...(cfg.model !== undefined ? { model: cfg.model } : {}),
		...(cfg.apiKeyEnv ? { apiKey: env[cfg.apiKeyEnv] } : {}),
	}
}

/**
 * The optional `decide` tool, or `undefined` when no provider is configured.
 * Absent config means the tool is simply not mounted; a configured model that
 * fails at call time is handled inside the tool (fail-open).
 */
export function maybeCreateDecisionTool(
	cfg: DecisionConfig | undefined,
	env: NodeJS.ProcessEnv,
): ToolDefinition | undefined {
	if (!cfg) return undefined
	return createDecisionTool(createDecisionModel(buildDecisionProviderConfig(cfg, env)))
}
