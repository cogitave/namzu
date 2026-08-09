/**
 * Declarative LLM provider registry — the single source of truth that
 * discovery, picker labeling, and runtime construction all derive from.
 *
 * Adding a provider means adding one entry here; nothing else in this
 * layer needs to change.
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
	/**
	 * Default model when the user does not pick one in the picker.
	 *
	 * **These are namzu's picks, not the provider's, and they go stale.** A
	 * hardcoded default fails silently: nothing errors, the run just happens on
	 * an older model than the operator assumes, and only a reader who already
	 * knows the current generation would notice. One sat two generations behind
	 * for exactly that reason.
	 *
	 * Resolving them at runtime was considered and refused: it buys a network
	 * call, a cache, and a staleness question on every launch, and the offline
	 * path is where this defect would reappear invisibly. So the constant stays
	 * and the obligation is stated instead — **re-check these at every provider
	 * model release.** The picker labels the value as namzu's default so an
	 * operator can see it is a choice rather than a recommendation.
	 */
	readonly defaultModel: string
	/** Does this provider require an apiKey? `false` for purely local. */
	readonly requiresApiKey: boolean
	/**
	 * Can THIS BUILD of the CLI construct one?
	 *
	 * A statement about `@namzu/cli`'s dependencies, not about the provider. A
	 * driver package exists in this repo for every entry below; only four of
	 * them are dependencies of this package, so only four can be imported and
	 * registered. Read the sentence that way or it will be deleted the day a
	 * driver ships, which would put the lie back.
	 *
	 * It exists because five things read this registry as truth — discovery,
	 * the picker, the chain validator, the doctor and `constructProvider` — and
	 * only the last of them knew better. It found out at the worst possible
	 * moment: after the operator had chosen from a list namzu offered them.
	 *
	 * `register.ts` is where the fact is *enforced*, and the two cannot drift:
	 * `register.test.ts` asserts the switch arms and these flags agree in both
	 * directions. A flag with no arm is the defect this field was added for; an
	 * arm with no flag would refuse a provider that works.
	 */
	readonly constructible: boolean
}

export const PROVIDER_REGISTRY: Readonly<Record<ProviderId, ProviderRegistryEntry>> = Object.freeze(
	{
		anthropic: {
			id: 'anthropic',
			label: 'Anthropic (Claude)',
			// Order: explicit anthropic key, then anthropic-token
			// variant, then claude-code's OAuth env (often present when the user
			// has claude-code installed).
			envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
			defaultModel: 'claude-opus-5',
			requiresApiKey: true,
			constructible: true,
		},
		openai: {
			id: 'openai',
			label: 'OpenAI',
			envVars: ['OPENAI_API_KEY'],
			defaultModel: 'gpt-4o',
			requiresApiKey: true,
			constructible: true,
		},
		openrouter: {
			id: 'openrouter',
			label: 'OpenRouter',
			envVars: ['OPENROUTER_API_KEY'],
			defaultBaseUrl: 'https://openrouter.ai/api/v1',
			defaultModel: 'anthropic/claude-opus-5',
			requiresApiKey: true,
			constructible: true,
		},
		ollama: {
			id: 'ollama',
			label: 'Ollama (local)',
			envVars: [],
			defaultBaseUrl: 'http://localhost:11434',
			probeUrl: 'http://localhost:11434/api/tags',
			defaultModel: 'llama3.2',
			requiresApiKey: false,
			constructible: true,
		},
		lmstudio: {
			id: 'lmstudio',
			label: 'LM Studio (local)',
			envVars: [],
			defaultBaseUrl: 'http://localhost:1234/v1',
			probeUrl: 'http://localhost:1234/v1/models',
			defaultModel: 'auto',
			requiresApiKey: false,
			constructible: false,
		},
		bedrock: {
			id: 'bedrock',
			label: 'AWS Bedrock',
			envVars: ['AWS_ACCESS_KEY_ID'], // SDK reads the rest from the AWS chain
			// UNVERIFIED, and left as-is deliberately. This driver talks to the
			// Converse API, whose ids are date-stamped and version-suffixed
			// (`<vendor>.<model>-<yyyymmdd>-v<n>:0`). This value carries the
			// suffix but no date, so it matches that shape and the newer bare
			// alias equally badly. Nobody here has a credential to prove which
			// the endpoint accepts, and inventing a date would be a fabricated
			// id that looks authoritative — so it is recorded rather than
			// guessed at. Unreachable today in any case: `constructible: false`
			// means this build cannot construct the driver at all.
			defaultModel: 'anthropic.claude-opus-4-7-v1:0',
			requiresApiKey: true,
			constructible: false,
		},
		http: {
			id: 'http',
			label: 'Custom HTTP (OpenAI-compatible)',
			// http is never auto-discovered; reserved for an explicit /provider
			// flow that lets the user enter a base URL + key.
			envVars: [],
			defaultModel: 'gpt-4o',
			requiresApiKey: true,
			constructible: false,
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

/**
 * The one sentence every refusal of an unbuildable provider uses.
 *
 * Written once because it is said in four places — the chain validator, the
 * picker, `ensureRegistered` and `constructProvider` — and four wordings of one
 * fact read as four problems. It names who refused, why, and the two things the
 * operator can actually do, per `docs/conventions/refuse-do-not-degrade.md`.
 *
 * "This build of namzu" and not "namzu": the driver exists, and telling someone
 * their provider is unsupported when the truth is that this package does not
 * depend on it yet sends them to the wrong place with the wrong bug report.
 */
export function unsupportedProviderMessage(id: string): string {
	const entry = (PROVIDER_REGISTRY as Record<string, ProviderRegistryEntry | undefined>)[id]
	const label = entry?.label ?? id
	const usable = ALL_PROVIDER_IDS.filter((other) => PROVIDER_REGISTRY[other].constructible).join(
		', ',
	)
	return `${label} ("${id}") is not available in this build of namzu — it has no driver bundled, so no session can use it. Pick one of: ${usable}. Following it is tracked in cogitave/namzu#257.`
}
