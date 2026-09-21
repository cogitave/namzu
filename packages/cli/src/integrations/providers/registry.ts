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
	| 'google'
	| 'openai'
	| 'openrouter'
	| 'zen'
	| 'zen-go'
	| 'deepseek'
	| 'ollama'
	| 'lmstudio'
	| 'bedrock'
	| 'http'

/** SDK type passed to `ProviderRegistry.create({type, ...})`. */
export type SdkProviderType = ProviderId

export type SubscriptionProviderId = 'anthropic' | 'codex'

/**
 * What each vendor's row in the provider picker is called, keyed by the vendor
 * an entry names.
 *
 * A vendor's name is written ONCE here rather than on every entry belonging to
 * it. Two entries carrying the same string are two entries that can disagree,
 * and which name a reader sees would then depend on which one a lookup reached
 * first. `VendorId` is derived from these keys, so a `vendor` field naming a
 * vendor that is not named here does not compile, and adding a vendor here is
 * adding one the type system knows about in the same edit.
 *
 * ## What is one vendor, and what only looks like one
 *
 * `openai` and `codex` are one vendor. They are one product reached two ways —
 * a subscription sign-in, or an API key — which is the shape `anthropic` has
 * always had in this registry: one id taking an API key, a token variable, or a
 * signed-in session. Two rows for it said the same vendor's name twice, and the
 * one holding the key had to work out which of the two rows was theirs.
 *
 * `zen` and `zen-go` are NOT merged, and the reason is the rule above rather
 * than a preference. They are one company's two services: separate catalogues,
 * separate billing routes, and disjoint keys — a key for one is not a way in to
 * the other. Merging them would put a product decision (which catalogue to run
 * on) inside a chooser whose title is about how to authenticate, and would hide
 * the one word — `Go` — that tells an operator they are choosing between two
 * priced things. `ollama` and `lmstudio` are two different local servers and
 * stay two rows for the same reason.
 *
 * A vendor with one member is a vendor too, and says so here: the field is
 * required on every entry so that no provider can fall outside the grouping by
 * omission.
 */
export const VENDOR_NAMES = Object.freeze({
	anthropic: 'Anthropic (Claude)',
	openai: 'OpenAI',
	google: 'Google (Gemini)',
	deepseek: 'DeepSeek',
	openrouter: 'OpenRouter',
	zen: 'Zen',
	'zen-go': 'Zen Go',
	ollama: 'Ollama (local)',
	lmstudio: 'LM Studio (local)',
	bedrock: 'AWS Bedrock',
	http: 'Custom HTTP (OpenAI-compatible)',
} as const)

/** The vendor a registry entry belongs to. Derived from `VENDOR_NAMES`. */
export type VendorId = keyof typeof VENDOR_NAMES

export interface ProviderRegistryEntry {
	readonly id: ProviderId
	readonly label: string
	/**
	 * The vendor whose picker row this entry belongs to.
	 *
	 * One row per vendor, not one per id: `codex` and `openai` are two ways to
	 * authenticate one product, and drawing them as two rows named the same
	 * vendor twice — a subscription session on one line and the API key it
	 * wanted on the next.
	 *
	 * A field rather than a table beside the picker, because which ids are one
	 * vendor is a fact ABOUT THE PROVIDERS. The picker is only the first surface
	 * to need it: the doctor, the chain validator and anything else that will
	 * ever group providers reads this registry, and a table in the screen would
	 * be a second list of providers — the thing `ALL_PROVIDER_IDS` is derived to
	 * avoid. See `VENDOR_NAMES` for which ids are one vendor and why.
	 */
	readonly vendor: VendorId
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
	 * hardcoded default fails silently: nothing errors, the turn just happens on
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
	/** Does every model require an apiKey? Local and public Zen models do not. */
	readonly requiresApiKey: boolean
	/** Whether the picker may accept an opaque credential typed by the operator. */
	readonly acceptsTypedCredential: boolean
	/** Namzu-owned login protocol, when this provider has one. */
	readonly subscriptionLogin?: 'browser' | 'device'
	/**
	 * Can THIS BUILD of the CLI construct one?
	 *
	 * A statement about `@namzu/cli`'s dependencies, not about the provider. A
	 * driver package exists in this repo for every entry below; only selected
	 * packages are dependencies of this package and can be imported and
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
			vendor: 'anthropic',
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
			// The subscription side of the vendor below: one product, two ways in.
			vendor: 'openai',
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
		google: {
			id: 'google',
			label: 'Google (Gemini)',
			vendor: 'google',
			envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
			defaultModel: 'gemini-2.5-flash',
			requiresApiKey: true,
			acceptsTypedCredential: true,
			constructible: true,
			driverPackage: '@namzu/google',
		},
		openai: {
			id: 'openai',
			label: 'OpenAI',
			// The key side of the vendor above. `VENDOR_NAMES` names the row this
			// and `codex` share.
			vendor: 'openai',
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
			vendor: 'deepseek',
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
			vendor: 'openrouter',
			envVars: ['OPENROUTER_API_KEY'],
			defaultBaseUrl: 'https://openrouter.ai/api/v1',
			defaultModel: 'anthropic/claude-opus-5',
			requiresApiKey: true,
			acceptsTypedCredential: true,
			constructible: true,
			driverPackage: '@namzu/openrouter',
		},
		zen: {
			id: 'zen',
			label: 'Zen',
			// Deliberately NOT the vendor `zen-go` names: see `VENDOR_NAMES`.
			vendor: 'zen',
			envVars: ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'],
			defaultBaseUrl: 'https://opencode.ai/zen/v1',
			defaultModel: 'muse-spark-1.3-contributor-free',
			requiresApiKey: false,
			acceptsTypedCredential: true,
			constructible: true,
			driverPackage: '@namzu/zen',
		},
		'zen-go': {
			id: 'zen-go',
			label: 'Zen Go',
			vendor: 'zen-go',
			// Go has its own billing route. A Zen key never opts an operator into it.
			envVars: ['OPENCODE_GO_API_KEY'],
			defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
			defaultModel: 'glm-5.3-flash',
			requiresApiKey: true,
			acceptsTypedCredential: true,
			constructible: true,
			driverPackage: '@namzu/zen',
		},
		ollama: {
			id: 'ollama',
			label: 'Ollama (local)',
			vendor: 'ollama',
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
			// A second local server, and not the vendor above: different software,
			// different port, and neither is a credential for the other.
			vendor: 'lmstudio',
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
			vendor: 'bedrock',
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
			vendor: 'http',
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
 * The entries one vendor is made of, in registry order.
 *
 * Derived by filtering `ALL_PROVIDER_IDS`, never listed: a vendor's members are
 * whatever says `vendor: <id>`, so an entry added to a vendor is a member of it
 * with no second edit. Registry order and not a preferred order — a caller that
 * needs "the first one that takes a typed credential" is asking a question
 * about the registry, and the registry answers it in the order it is written.
 */
export function providerEntriesOfVendor(vendor: VendorId): readonly ProviderRegistryEntry[] {
	return ALL_PROVIDER_IDS.map((id) => PROVIDER_REGISTRY[id]).filter(
		(entry) => entry.vendor === vendor,
	)
}

/**
 * The one sentence every refusal of an unbuildable provider uses.
 *
 * Written once because it is said in four places — the chain validator, the
 * picker, `ensureRegistered` and `constructProvider` — and four wordings of one
 * fact read as four problems. It names who refused, why, and the two things the
 * operator can actually do, per "refuse do not degrade".
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
 * this case did not — see "read the neighbour".
 *
 * The environment variables are still named. They are how the credential
 * becomes durable, and the entry screen holds one only for the session.
 */
export function missingCredentialMessage(entry: ProviderRegistryEntry): string {
	const looked =
		entry.envVars.length > 0 ? ` namzu looked for ${entry.envVars.join(', ')} and found none.` : ''
	return `No credential found for ${entry.label}, your saved provider.${looked} Enter one below with "k", or choose a different provider.`
}
