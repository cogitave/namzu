/**
 * `ProviderProfile` discriminated union.
 *
 * Each provider type mirrors a `@namzu/<type>` package the SDK ships. The
 * shapes are the *minimum* the CLI persists; richer per-type knobs (Bedrock
 * IAM role assumption, OpenRouter routing rules, Anthropic `maxTokens`,
 * etc.) come in as additive optional fields when M3+ surface needs them.
 *
 * Validation is intentionally hand-rolled (no Zod) — we want zero-runtime-dep
 * config IO in M2; a future session can introduce a schema library when
 * provider-package-specific knobs start to collide.
 */

export type ProviderType =
	| 'openai'
	| 'anthropic'
	| 'openrouter'
	| 'ollama'
	| 'bedrock'
	| 'http'
	| 'lmstudio'

export const PROVIDER_TYPES: readonly ProviderType[] = [
	'openai',
	'anthropic',
	'openrouter',
	'ollama',
	'bedrock',
	'http',
	'lmstudio',
] as const

/**
 * Per-type API-key env-var fallback. Order checked: `NAMZU_<NAME>_API_KEY`
 * (per-profile override) → entry below (per-type vendor default) → empty.
 * Mirrors what users already have set in CI / shells for other tools.
 */
export const TYPE_ENV_FALLBACK: Readonly<Record<ProviderType, string | null>> = Object.freeze({
	openai: 'OPENAI_API_KEY',
	anthropic: 'ANTHROPIC_API_KEY',
	openrouter: 'OPENROUTER_API_KEY',
	ollama: null, // local server; no API key concept
	bedrock: null, // AWS SDK credential chain; handled in M3
	http: null, // generic; user supplies via apiKey or per-profile env
	lmstudio: null, // local server
})

export interface BaseProfile {
	readonly name: string
	readonly default?: boolean
	readonly model?: string
}

export interface OpenAIProfile extends BaseProfile {
	readonly type: 'openai'
	readonly apiKey?: string
	readonly baseUrl?: string
	readonly organization?: string
	readonly project?: string
}

export interface AnthropicProfile extends BaseProfile {
	readonly type: 'anthropic'
	readonly apiKey?: string
	readonly baseUrl?: string
}

export interface OpenRouterProfile extends BaseProfile {
	readonly type: 'openrouter'
	readonly apiKey?: string
	readonly baseUrl?: string
}

export interface OllamaProfile extends BaseProfile {
	readonly type: 'ollama'
	readonly host?: string
}

export interface BedrockProfile extends BaseProfile {
	readonly type: 'bedrock'
	readonly region?: string
}

export interface HttpProfile extends BaseProfile {
	readonly type: 'http'
	readonly baseUrl: string
	readonly apiKey?: string
	readonly dialect?: 'openai' | 'anthropic'
}

export interface LMStudioProfile extends BaseProfile {
	readonly type: 'lmstudio'
	readonly host?: string
}

export type ProviderProfile =
	| OpenAIProfile
	| AnthropicProfile
	| OpenRouterProfile
	| OllamaProfile
	| BedrockProfile
	| HttpProfile
	| LMStudioProfile

export interface ProvidersFile {
	readonly version: 1
	readonly profiles: readonly ProviderProfile[]
}

export const PROVIDERS_FILE_VERSION = 1 as const

export class ProfileValidationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ProfileValidationError'
	}
}

/** Strict at-the-boundary validator. Throws `ProfileValidationError` on bad input. */
export function validateProfile(value: unknown): ProviderProfile {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ProfileValidationError('profile must be a JSON object')
	}
	const v = value as Record<string, unknown>
	if (typeof v.name !== 'string' || v.name.length === 0) {
		throw new ProfileValidationError('profile.name is required')
	}
	if (!isProviderType(v.type)) {
		throw new ProfileValidationError(`profile.type must be one of: ${PROVIDER_TYPES.join(', ')}`)
	}
	if (v.default !== undefined && typeof v.default !== 'boolean') {
		throw new ProfileValidationError('profile.default must be a boolean')
	}
	if (v.model !== undefined && typeof v.model !== 'string') {
		throw new ProfileValidationError('profile.model must be a string')
	}
	// http requires baseUrl; others optional. We trust the discriminator.
	if (v.type === 'http' && (typeof v.baseUrl !== 'string' || v.baseUrl.length === 0)) {
		throw new ProfileValidationError('profile.baseUrl is required when type=http')
	}
	return v as unknown as ProviderProfile
}

export function isProviderType(value: unknown): value is ProviderType {
	return typeof value === 'string' && (PROVIDER_TYPES as readonly string[]).includes(value)
}
