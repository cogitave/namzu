/**
 * Credential discoverer for LLM provider clients.
 *
 * For each entry in `PROVIDER_REGISTRY`, ask three questions in order:
 *   1. Is one of its env vars set in `process.env`?
 *   2. Is there an OAuth credential in the login Keychain? (macOS only, and
 *      only `anthropic` consumes it.)
 *   3. Is the probe URL (if any) reachable right now?
 *
 * The header used to say "three" and list two, and the one it omitted was the
 * Keychain — the question that reads a secret off the machine, so the one a
 * reader most needs to see. A count that disagrees with its own list is the
 * tell that the list stopped being maintained; in a file about credentials that
 * is worth more than a typo.
 *
 * **The Keychain path is macOS-only and that is a gap, not a nuance.**
 * `readAgentKeychainCredential` returns `null` on any other platform before it
 * looks at anything, so on Windows and Linux exactly two doors exist: an
 * environment variable, and a reachable local server. An operator whose
 * credential lives in their OS credential store gets no help from namzu there.
 *
 * The first positive answer per provider wins; subsequent sources are
 * recorded as "also available from" so the picker can show alternatives
 * (e.g. anthropic via env, also reachable as a local server).
 *
 * ## Membership means "usable right now", and two consumers depend on that
 *
 * A provider appears in the returned list only when a source actually answered.
 * That is not merely a description of the loop — it is the contract the readers
 * are built on, and it is why this function does NOT return a local provider
 * whose server is down:
 *
 *  - the `providers.chain` doctor check reads presence itself as the verdict
 *    for a provider that needs no key (`requiresApiKey ? apiKey : Boolean(det)`),
 *    so an unreachable entry would make it print `reachable` for a dead server;
 *  - the session's chain builder applies no credential test to a local
 *    provider, so an unreachable entry would be built into the chain and fail
 *    on the day it was supposed to rescue a run.
 *
 * `DetectionSource` has no way to say "found, not usable" either — every
 * variant asserts a working source.
 *
 * A dead branch here used to propose the opposite: list a local provider whose
 * probe failed, so the picker could show `(not running)` and the operator would
 * know they could start the server. It was removed rather than built, because
 * the operator-facing half of that idea already exists somewhere better — the
 * picker's empty state names both local servers and their ports and says to
 * start one — while the machine-facing half would have made the two readers
 * above lie. See cogitave/namzu#258.
 *
 * Discovery is non-throwing. Network probes have short timeouts. The
 * picker can render immediately and refine if discovery completes later.
 */

import { KEYCHAIN_SERVICE, readAgentKeychainCredential } from './keychain.js'
import { PROVIDER_REGISTRY, type ProviderId, type ProviderRegistryEntry } from './registry.js'

export type DetectionSource =
	| { readonly kind: 'env'; readonly envName: string }
	| { readonly kind: 'probe'; readonly url: string }
	| { readonly kind: 'keychain'; readonly service: string }
	/**
	 * Typed into a running namzu and held in memory for this session.
	 *
	 * Never produced by `discoverProviders` — discovery reads the machine, and
	 * this one came from a person. It is in the union so a credential the
	 * operator typed flows through every path that handles a discovered one,
	 * differing only where a surface says where it came from.
	 */
	| { readonly kind: 'session' }

export interface DetectedProvider {
	readonly entry: ProviderRegistryEntry
	/** First positive source (used by default). */
	readonly source: DetectionSource
	/** Resolved API key, if the source carried one. */
	readonly apiKey?: string
	/** Resolved base URL (overrides the registry default if set). */
	readonly baseUrl?: string
	/**
	 * OAuth refresh metadata, present only when `apiKey` is an OAuth access
	 * token carrying a refresh token + expiry (the Keychain source). Lets
	 * the session layer renew a lapsed token instead of failing with a 401.
	 */
	readonly oauth?: { readonly refreshToken?: string; readonly expiresAt?: number }
	/** Other sources that also satisfy this provider — informational. */
	readonly alternatives: readonly DetectionSource[]
}

export interface DiscoverOptions {
	/** Override `process.env` for tests. */
	readonly env?: NodeJS.ProcessEnv
	/** Override `homedir()` for tests. */
	readonly home?: string
	/** Override the fetch impl for probe URLs (tests inject a mock). */
	readonly fetch?: typeof fetch
	/** Probe deadline in ms (default 500). */
	readonly probeTimeoutMs?: number
	/** Skip network probes entirely (tests, offline mode). */
	readonly skipProbes?: boolean
	/** Skip the macOS Keychain read (tests, non-darwin runs). */
	readonly skipKeychain?: boolean
}

const DEFAULT_PROBE_TIMEOUT_MS = 500

export async function discoverProviders(
	opts: DiscoverOptions = {},
): Promise<readonly DetectedProvider[]> {
	const env = opts.env ?? process.env
	const detected: DetectedProvider[] = []

	// macOS-only: read the third-party OAuth credential stored in the login
	// Keychain once. Only anthropic consumes it, but we scan up front so
	// the loop body stays uniform.
	const keychainCredential = opts.skipKeychain ? null : readAgentKeychainCredential()

	for (const id of Object.keys(PROVIDER_REGISTRY) as readonly ProviderId[]) {
		const entry = PROVIDER_REGISTRY[id]
		const sources: DetectionSource[] = []
		let apiKey: string | undefined
		let oauth: DetectedProvider['oauth']
		for (const envName of entry.envVars) {
			const v = env[envName]
			if (v && v.length > 0) {
				if (apiKey === undefined) apiKey = v
				sources.push({ kind: 'env', envName })
			}
		}
		if (id === 'anthropic' && keychainCredential) {
			if (apiKey === undefined) apiKey = keychainCredential.accessToken
			sources.push({ kind: 'keychain', service: KEYCHAIN_SERVICE })
			// Only carry refresh metadata when the Keychain token is the one we'll
			// actually use (an env/secrets token has no refresh path).
			if (apiKey === keychainCredential.accessToken) {
				oauth = {
					refreshToken: keychainCredential.refreshToken,
					expiresAt: keychainCredential.expiresAt,
				}
			}
		}
		if (sources.length === 0 && entry.probeUrl && !opts.skipProbes) {
			const reachable = await probe(entry.probeUrl, opts)
			if (reachable) {
				sources.push({ kind: 'probe', url: entry.probeUrl })
			}
		}
		if (sources.length > 0) {
			detected.push({
				entry,
				source: sources[0] as DetectionSource,
				apiKey,
				baseUrl: entry.defaultBaseUrl,
				...(oauth ? { oauth } : {}),
				alternatives: sources.slice(1),
			})
		}
	}
	return detected
}

async function probe(url: string, opts: DiscoverOptions): Promise<boolean> {
	const fetchFn = opts.fetch ?? globalThis.fetch
	const controller = new AbortController()
	const timer = setTimeout(
		() => controller.abort(),
		opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
	)
	try {
		const res = await fetchFn(url, { method: 'GET', signal: controller.signal })
		return res.ok
	} catch {
		return false
	} finally {
		clearTimeout(timer)
	}
}

/** Resolve a single detected provider by id from the discovered list. */
export function findDetected(
	list: readonly DetectedProvider[],
	id: ProviderId,
): DetectedProvider | null {
	return list.find((d) => d.entry.id === id) ?? null
}
