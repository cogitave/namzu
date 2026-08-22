/**
 * Declarative LLM provider registry — the single source of truth that
 * discovery, picker labeling, and runtime construction all derive from.
 *
 * Adding a provider means adding one entry here; nothing else in this
 * layer needs to change.
 */

export type ProviderId =
	| 'anthropic'
	| 'codex'
	| 'openai'
	| 'openrouter'
	| 'deepseek'
	| 'ollama'
	| 'lmstudio'
	| 'bedrock'
	| 'http'

/** SDK type passed to `ProviderRegistry.create({type, ...})`. */
export type SdkProviderType = ProviderId

export type SubscriptionProviderId = 'anthropic' | 'codex'

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
	/** Whether the picker may accept an opaque credential typed by the operator. */
	readonly acceptsTypedCredential: boolean
	/** Namzu-owned login protocol, when this provider has one. */
	readonly subscriptionLogin?: 'browser' | 'device'
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
	/** Package this CLI imports for the driver. Multiple transports may share one. */
	readonly driverPackage?: `@namzu/${string}`
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
			acceptsTypedCredential: true,
			subscriptionLogin: 'browser',
			constructible: true,
			driverPackage: '@namzu/anthropic',
		},
		codex: {
			id: 'codex',
			label: 'OpenAI (Codex subscription)',
			// A Codex subscription token is never accepted through an environment
			// variable here. It is a Responses credential with account routing, not
			// an OpenAI API key; discovery reads its complete owned envelope instead.
			envVars: [],
			defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
			defaultModel: 'gpt-5.6-sol',
			requiresApiKey: true,
			acceptsTypedCredential: false,
			subscriptionLogin: 'device',
			constructible: true,
			driverPackage: '@namzu/openai',
		},
		openai: {
			id: 'openai',
			label: 'OpenAI',
			envVars: ['OPENAI_API_KEY'],
			defaultModel: 'gpt-4o',
			requiresApiKey: true,
			acceptsTypedCredential: true,
			constructible: true,
			driverPackage: '@namzu/openai',
		},
		deepseek: {
			id: 'deepseek',
			label: 'DeepSeek',
			envVars: ['DEEPSEEK_API_KEY'],
			defaultBaseUrl: 'https://api.deepseek.com',
			// The smaller of the two models the vendor serves. `deepseek-chat`
			// and `deepseek-reasoner` are NOT alternatives to name here: both
			// were discontinued on 2026-07-24 and resolve to nothing.
			defaultModel: 'deepseek-v4-flash',
			requiresApiKey: true,
			acceptsTypedCredential: true,
			constructible: true,
			driverPackage: '@namzu/deepseek',
		},
		openrouter: {
			id: 'openrouter',
			label: 'OpenRouter',
			envVars: ['OPENROUTER_API_KEY'],
			defaultBaseUrl: 'https://openrouter.ai/api/v1',
			defaultModel: 'anthropic/claude-opus-5',
			requiresApiKey: true,
			acceptsTypedCredential: true,
			constructible: true,
			driverPackage: '@namzu/openrouter',
		},
		ollama: {
			id: 'ollama',
			label: 'Ollama (local)',
			envVars: [],
			defaultBaseUrl: 'http://localhost:11434',
			probeUrl: 'http://localhost:11434/api/tags',
			defaultModel: 'llama3.2',
			requiresApiKey: false,
			acceptsTypedCredential: false,
			constructible: true,
			driverPackage: '@namzu/ollama',
		},
		lmstudio: {
			id: 'lmstudio',
			label: 'LM Studio (local)',
			envVars: [],
			defaultBaseUrl: 'http://localhost:1234/v1',
			probeUrl: 'http://localhost:1234/v1/models',
			defaultModel: 'auto',
			requiresApiKey: false,
			acceptsTypedCredential: false,
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
			acceptsTypedCredential: true,
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
			acceptsTypedCredential: true,
			constructible: false,
		},
	},
)

/**
 * Every provider this build knows about, in registry order.
 *
 * DERIVED from `PROVIDER_REGISTRY` rather than listed beside it. It was a
 * hand-written array typed `readonly ProviderId[]`, and that type accepts a
 * SUBSET — so adding a provider to the union and to the registry while
 * forgetting this line compiled, ran, and left the new provider invisible to
 * every consumer that iterates: the picker, the chain validator, and the test
 * that holds `ensureRegistered` in agreement with `constructible`. Which is
 * exactly what happened when `deepseek` was added, and the test written to
 * catch that class of mistake was itself vacuous for the one provider it was
 * written alongside.
 *
 * `PROVIDER_REGISTRY` is a `Record<ProviderId, …>`, so its keys are exhaustive
 * by construction and a missing entry is a compile error rather than a silent
 * omission.
 */
export const ALL_PROVIDER_IDS: readonly ProviderId[] = Object.freeze(
	Object.keys(PROVIDER_REGISTRY) as ProviderId[],
)

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

/**
 * The sentence an operator reads when their SAVED provider needs a credential
 * and this machine has none.
 *
 * Deliberately different from the one `createAgentSession` prints for the same
 * fact, and the difference is the whole point. That one is read by a headless
 * run, where the answers are an environment variable or `--provider`. This one
 * is printed directly above the picker, so it names what the picker offers:
 * enter one now, or choose something else. Advice that matches the screen it is
 * printed on is the property the unbuildable-primary refusal already has and
 * this case did not — see `docs/conventions/read-the-neighbour.md`.
 *
 * The environment variables are still named. They are how the credential
 * becomes durable, and the entry screen holds one only for the session.
 */
export function missingCredentialMessage(entry: ProviderRegistryEntry): string {
	const looked =
		entry.envVars.length > 0 ? ` namzu looked for ${entry.envVars.join(', ')} and found none.` : ''
	return `No credential found for ${entry.label}, your saved provider.${looked} Enter one below with "k", or choose a different provider.`
}
