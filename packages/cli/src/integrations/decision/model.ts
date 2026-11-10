import {
	type DecisionModel,
	type DecisionProviderConfig,
	createDecisionModel,
	createDecisionTool,
} from '@namzu/decision'
import type { ToolDefinition } from '@namzu/sdk'
import type { DecisionConfig } from '../../config/schema.js'
import { readDecisionKey } from './connection.js'
import { type RunAz, createAzureTokenSource } from './token.js'

/** What `buildDecisionProviderConfig` reads besides the config and the environment; every part is a test seam. */
export interface DecisionBuildDeps {
	/** The key saved for the decision model, read lazily and once. Defaults to the private credential store. */
	readonly readStoredKey?: () => string | null
	readonly fetch?: typeof fetch
	readonly now?: () => number
	readonly runAz?: RunAz
	readonly findAz?: (env: NodeJS.ProcessEnv) => string | undefined
}

/**
 * Map the declarative `decision` config block plus the environment to the
 * package's provider config. A variable the config names wins; with none named,
 * the key saved when the model was connected is used; an azure model with no key
 * at all uses a bearer token (`AZURE_FOUNDRY_TOKEN`, else `az`, kept until five
 * minutes before it expires). Credentials are read at call time, never stored here.
 */
export function buildDecisionProviderConfig(
	cfg: DecisionConfig,
	env: NodeJS.ProcessEnv,
	deps: DecisionBuildDeps = {},
): DecisionProviderConfig {
	const readStored = deps.readStoredKey ?? (() => readDecisionKey())
	// One read of the private file per run: on Windows each read proves the file private.
	let stored: string | null | undefined
	const storedKey = (): string | null => {
		if (stored === undefined) {
			try {
				stored = readStored()
			} catch {
				stored = null
			}
		}
		return stored
	}
	const fetchPart = deps.fetch ? { fetch: deps.fetch } : {}
	if (cfg.provider === 'azure') {
		const named = cfg.apiKeyEnv
		const keyed = named !== undefined || (cfg.tokenEnv === undefined && storedKey() !== null)
		return {
			provider: 'azure',
			endpoint: cfg.endpoint,
			deployment: cfg.deployment,
			...fetchPart,
			// A key, read at each call, or a bearer token; never both (the loader refuses a config naming both).
			...(keyed
				? { getApiKey: () => (named ? (env[named] ?? '') : (storedKey() ?? '')) }
				: {
						getToken: createAzureTokenSource(cfg.tokenEnv, {
							env,
							...(deps.now ? { now: deps.now } : {}),
							...(deps.runAz ? { runAz: deps.runAz } : {}),
							...(deps.findAz ? { findAz: deps.findAz } : {}),
						}),
					}),
		}
	}
	const named = cfg.apiKeyEnv
	if (named) {
		return {
			provider: 'http',
			url: cfg.url,
			...(cfg.model !== undefined ? { model: cfg.model } : {}),
			...fetchPart,
			apiKey: env[named],
		}
	}
	// A saved key is attached when a request is made, so a launch that never asks reads nothing.
	const baseFetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init))
	return {
		provider: 'http',
		url: cfg.url,
		...(cfg.model !== undefined ? { model: cfg.model } : {}),
		fetch: (input, init) => {
			const key = storedKey()
			if (!key) return baseFetch(input, init)
			const headers = new Headers(init?.headers)
			headers.set('Authorization', `Bearer ${key}`)
			return baseFetch(input, { ...init, headers })
		},
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
	deps: DecisionBuildDeps = {},
): ToolDefinition | undefined {
	if (!cfg || decisionSwitchedOff(env)) return undefined
	return createDecisionTool(createDecisionModel(buildDecisionProviderConfig(cfg, env, deps)))
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
	deps: DecisionBuildDeps = {},
): DecisionModel | undefined {
	if (!cfg || decisionSwitchedOff(env)) return undefined
	return createDecisionModel(buildDecisionProviderConfig(cfg, env, deps))
}
