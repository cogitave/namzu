/**
 * Declarative LLM provider registry — the single source of truth that
 * discovery, picker labeling, and runtime construction all derive from.
 *
 * Pattern lifted from NousResearch hermes-agent's `PROVIDER_REGISTRY`
 * (`hermes_cli/auth.py:183-457`). Adding a provider = adding one entry
 * here; nothing else in this layer needs to change.
 */

export type ProviderId =
	| 'anthropic'
	| 'openai'
	| 'openrouter'
	| 'ollama'
	| 'lmstudio'
	| 'bedrock'
	| 'http'

/** SDK type passed to `ProviderRegistry.create({type, ...})`. */
export type SdkProviderType = ProviderId

export interface ProviderRegistryEntry {
	readonly id: ProviderId
	readonly label: string
	/** Env vars searched in order for an API key. First non-empty wins. */
	readonly envVars: readonly string[]
	/** Default base URL if the provider has one (else SDK default). */
	readonly defaultBaseUrl?: string
	/**
	 * Probe URL for ambient detection (e.g. local server). When set, the
	 * discoverer issues a HEAD/GET and treats 2xx as "available".
	 */
	readonly probeUrl?: string
	/** Default model when the user does not pick one in the picker. */
	readonly defaultModel: string
	/** Does this provider require an apiKey? `false` for purely local. */
	readonly requiresApiKey: boolean
}

export const PROVIDER_REGISTRY: Readonly<Record<ProviderId, ProviderRegistryEntry>> = Object.freeze(
	{
		anthropic: {
			id: 'anthropic',
			label: 'Anthropic (Claude)',
			// Order mirrors hermes: explicit anthropic key, then anthropic-token
			// variant, then claude-code's OAuth env (often present when the user
			// has claude-code installed).
			envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
			defaultModel: 'claude-opus-4-7',
			requiresApiKey: true,
		},
		openai: {
			id: 'openai',
			label: 'OpenAI',
			envVars: ['OPENAI_API_KEY'],
			defaultModel: 'gpt-4o',
			requiresApiKey: true,
		},
		openrouter: {
			id: 'openrouter',
			label: 'OpenRouter',
			envVars: ['OPENROUTER_API_KEY'],
			defaultBaseUrl: 'https://openrouter.ai/api/v1',
			defaultModel: 'anthropic/claude-opus-4-7',
			requiresApiKey: true,
		},
		ollama: {
			id: 'ollama',
			label: 'Ollama (local)',
			envVars: [],
			defaultBaseUrl: 'http://localhost:11434',
			probeUrl: 'http://localhost:11434/api/tags',
			defaultModel: 'llama3.2',
			requiresApiKey: false,
		},
		lmstudio: {
			id: 'lmstudio',
			label: 'LM Studio (local)',
			envVars: [],
			defaultBaseUrl: 'http://localhost:1234/v1',
			probeUrl: 'http://localhost:1234/v1/models',
			defaultModel: 'auto',
			requiresApiKey: false,
		},
		bedrock: {
			id: 'bedrock',
			label: 'AWS Bedrock',
			envVars: ['AWS_ACCESS_KEY_ID'], // SDK reads the rest from the AWS chain
			defaultModel: 'anthropic.claude-opus-4-7-v1:0',
			requiresApiKey: true,
		},
		http: {
			id: 'http',
			label: 'Custom HTTP (OpenAI-compatible)',
			// http is never auto-discovered; reserved for an explicit /provider
			// flow that lets the user enter a base URL + key.
			envVars: [],
			defaultModel: 'gpt-4o',
			requiresApiKey: true,
		},
	},
)

export const ALL_PROVIDER_IDS: readonly ProviderId[] = Object.freeze([
	'anthropic',
	'openai',
	'openrouter',
	'ollama',
	'lmstudio',
	'bedrock',
	'http',
] as const)
