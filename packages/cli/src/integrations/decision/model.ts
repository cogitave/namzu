import {
	type DecisionModel,
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
			// A key, read at each call, or a bearer token; never both (the loader refuses a config naming both).
			...(cfg.apiKeyEnv
				? { getApiKey: () => env[cfg.apiKeyEnv as string] ?? '' }
				: { getToken: async () => env[cfg.tokenEnv ?? 'AZURE_FOUNDRY_TOKEN'] ?? '' }),
		}
	}
	return {
		provider: 'http',
		url: cfg.url,
		...(cfg.model !== undefined ? { model: cfg.model } : {}),
		...(cfg.apiKeyEnv ? { apiKey: env[cfg.apiKeyEnv] } : {}),
	}
}

/** `NAMZU_NO_DECISION=1` turns every use of the decision model off, whatever the config says. */
export const DECISION_KILL_SWITCH = 'NAMZU_NO_DECISION'

function decisionSwitchedOff(env: NodeJS.ProcessEnv): boolean {
	return env[DECISION_KILL_SWITCH] === '1'
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
	if (!cfg || decisionSwitchedOff(env)) return undefined
	return createDecisionTool(createDecisionModel(buildDecisionProviderConfig(cfg, env)))
}

/**
 * The decision model itself, or `undefined` when no provider is configured.
 * Auto model routing calls this directly (its `yesno` and `score` methods)
 * and handles failure itself; the fail-open `decide` tool is for the agent
 * mid-turn, not for the host choosing which model runs the turn.
 */
export function maybeCreateDecisionModel(
	cfg: DecisionConfig | undefined,
	env: NodeJS.ProcessEnv,
): DecisionModel | undefined {
	if (!cfg || decisionSwitchedOff(env)) return undefined
	return createDecisionModel(buildDecisionProviderConfig(cfg, env))
}
