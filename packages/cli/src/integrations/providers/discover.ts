/**
 * Credential discoverer for LLM provider clients.
 *
 * For each entry in `PROVIDER_REGISTRY`, ask four questions:
 *   1. Is there a usable session owned by an installed Claude or Codex harness?
 *   2. Is there a subscription credential in namzu's own store?
 *   3. Is one of its optional API-key env vars set in `process.env`?
 *   4. Is the probe URL (if any) reachable right now?
 *
 * The header used to say "three" and list two, and the one it omitted was the
 * Keychain — the question that reads a secret off the machine, so the one a
 * reader most needs to see. A count that disagrees with its own list is the
 * tell that the list stopped being maintained; in a file about credentials that
 * is worth more than a typo.
 *
 * **The Keychain path is macOS-only, and question 2 is why that is no longer a
 * hole.** `readAgentKeychainCredential` returns `null` on any other platform
 * before it looks at anything; it reads a credential belonging to a
 * co-installed tool, so it can only ever help someone who has that tool, on
 * that operating system. namzu's own store works everywhere, which is what
 * makes signing in from inside namzu useful on a machine that has neither.
 *
 * Order matters when both answer. A current device-harness session wins; a
 * Namzu-owned sign-in is the fallback for a machine that has no usable harness
 * session. API-key/env sources remain optional alternatives after both.
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

import { EnvCredentialProvider } from '@namzu/sdk'

import {
	credentialsPath,
	readStoredCodexCredential,
	readStoredSubscriptionCredential,
} from './credential-store.js'
import {
	preferFresherCredential,
	readClaudeFileCredentialCandidates,
	readCodexFileCredentialCandidates,
} from './harness-credentials.js'
import { KEYCHAIN_SERVICE, readAgentKeychainCredential } from './keychain.js'
import type { CredentialOrigin } from './oauth.js'
import { PROVIDER_REGISTRY, type ProviderId, type ProviderRegistryEntry } from './registry.js'

export type DetectionSource =
	| { readonly kind: 'env'; readonly envName: string }
	| { readonly kind: 'probe'; readonly url: string }
	| { readonly kind: 'keychain'; readonly service: string }
	/** A read-only Claude Code OAuth envelope owned by the Claude CLI. */
	| { readonly kind: 'claude-file'; readonly path: string }
	/** A read-only ChatGPT/Codex OAuth envelope owned by the Codex CLI. */
	| { readonly kind: 'codex-file'; readonly path: string }
	/**
	 * namzu's own credential store — a subscription the operator signed in to
	 * from inside namzu. Carries the path because "where did this come from"
	 * is the first question asked of a credential nobody typed.
	 */
	| { readonly kind: 'stored'; readonly path: string }
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
	 * token carrying a refresh token + expiry (namzu's own store, or the
	 * Keychain). Lets the session layer renew a lapsed token instead of
	 * failing with a 401.
	 *
	 * `origin` travels with it because the refresh has to be written BACK, and
	 * the two sources are not interchangeable: one is namzu's file and the
	 * other is a co-installed tool's Keychain entry.
	 */
	readonly oauth?: {
		readonly refreshToken?: string
		readonly expiresAt?: number
		readonly origin?: CredentialOrigin
		/** Exact Claude owner file admitted by discovery. */
		readonly sourcePath?: string
	}
	/** Account-routed OAuth metadata for the Codex Responses backend. */
	readonly codex?: {
		readonly accountId: string
		readonly expiresAt?: number
		readonly origin: 'codex-file' | 'stored'
	}
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
	/** Skip namzu's own credential store (tests, and `--no-stored-credential`). */
	readonly skipStored?: boolean
	/** Explicit paired Windows home for a WSL credential fixture. */
	readonly windowsHome?: string | null
}

/**
 * Providers backed by a subscription session that is already usable now.
 *
 * This is intentionally narrower than "detected providers". An API key, a
 * custom endpoint, and a local model are all valid optional choices, but none
 * means the operator has already signed in to Claude or Codex. First-run
 * routing uses this distinction to avoid asking for a second credential when
 * the device already owns one.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` is included because it is the environment form of
 * the same Claude device session. Generic Anthropic token/key variables are
 * not: they are explicit API credentials and remain ordinary picker choices.
 */
export function signedInSubscriptionProviders(
	detected: readonly DetectedProvider[],
): readonly DetectedProvider[] {
	return detected.filter((provider) => {
		if (provider.entry.subscriptionLogin === undefined) return false
		return [provider.source, ...provider.alternatives].some(
			(source) =>
				source.kind === 'claude-file' ||
				source.kind === 'codex-file' ||
				source.kind === 'keychain' ||
				source.kind === 'stored' ||
				(source.kind === 'env' && source.envName === 'CLAUDE_CODE_OAUTH_TOKEN'),
		)
	})
}

const DEFAULT_PROBE_TIMEOUT_MS = 500

export async function discoverProviders(
	opts: DiscoverOptions = {},
): Promise<readonly DetectedProvider[]> {
	const env = opts.env ?? process.env
	// `anyKey`, because the registry's `envVars` are credential names BY
	// CONSTRUCTION — the seam's own name filter would be a second opinion on
	// a list that is already the answer, and a provider whose variable did
	// not look credential-shaped would silently stop being discovered.
	// The vocabulary agreement is asserted instead, where it can fail loudly.
	const credentials = new EnvCredentialProvider({ env, anyKey: true })
	const detected: DetectedProvider[] = []

	// Read both credential sources once, up front, so the loop body stays
	// uniform. Only anthropic consumes either.
	//
	// ## Two lookups, one store per credential — do not "fix" this
	//
	// These are two SOURCES, not two stores, and the difference is the whole
	// design. A credential belongs to exactly one of them for its whole life:
	// the one namzu obtained lives in namzu's file, the one a co-installed tool
	// obtained lives in that tool's Keychain entry, and `origin` — set below and
	// carried on the detected provider — is what pairs every later READ with the
	// matching WRITE (see `oauth.ts`).
	//
	// So the two obvious tidy-ups are both defects:
	//
	//  - **Merging them into one lookup** would blend fields across sources —
	//    an access token from one with a refresh token from the other. The
	//    refresh would then be attempted with a token the endpoint never issued
	//    against that access token, and the failure surfaces as a 401 in a
	//    session the operator signed into successfully.
	//  - **Writing a refresh back to both** would put namzu's secret in another
	//    product's envelope, under their name, and give one credential two
	//    homes that drift the moment either side rotates.
	//
	// A second lookup is not a gap to be closed; it is the only way to reach a
	// credential namzu did not write. What must stay single is the store each
	// credential is read from and written to, and that is `origin`'s job.
	const storedCredential = opts.skipStored
		? null
		: readStoredSubscriptionCredential(...(opts.home === undefined ? [] : [opts.home]))
	const storedCodexCredential = opts.skipStored
		? null
		: readStoredCodexCredential(...(opts.home === undefined ? [] : [opts.home]))
	// macOS-only: the OAuth credential a co-installed tool keeps in the login
	// Keychain.
	const keychainCredential = opts.skipKeychain ? null : readAgentKeychainCredential()
	const claudeFileCredentials = readClaudeFileCredentialCandidates(opts.home, env, opts.windowsHome)
	const codexFileCredentials = readCodexFileCredentialCandidates(
		opts.home,
		env,
		opts.windowsHome,
	).filter(
		(candidate) =>
			candidate.credential.expiresAt === undefined ||
			candidate.credential.expiresAt - Date.now() > 60_000,
	)
	const usableCodexFileCredential = codexFileCredentials.reduce<
		(typeof codexFileCredentials)[number] | null
	>((current, candidate) => {
		if (!current) return candidate
		return preferFresherCredential(current.credential, candidate.credential) ===
			candidate.credential
			? candidate
			: current
	}, null)

	for (const id of Object.keys(PROVIDER_REGISTRY) as readonly ProviderId[]) {
		const entry = PROVIDER_REGISTRY[id]
		const sources: DetectionSource[] = []
		let apiKey: string | undefined
		let oauth: DetectedProvider['oauth']
		let codex: DetectedProvider['codex']

		if (id === 'anthropic') {
			const borrowedCandidates = [
				...claudeFileCredentials.map(({ credential, path }) => ({
					credential,
					source: { kind: 'claude-file', path } as const,
				})),
				...(keychainCredential
					? [
							{
								credential: keychainCredential,
								source: { kind: 'keychain', service: KEYCHAIN_SERVICE } as const,
							},
						]
					: []),
			].filter(
				(candidate) =>
					candidate.credential.expiresAt === undefined ||
					candidate.credential.expiresAt - Date.now() > 60_000 ||
					(candidate.source.kind === 'claude-file' &&
						candidate.credential.refreshToken !== undefined),
			)
			const borrowed = borrowedCandidates.reduce<(typeof borrowedCandidates)[number] | null>(
				(current, candidate) => {
					if (!current) return candidate
					return preferFresherCredential(current.credential, candidate.credential) ===
						candidate.credential
						? candidate
						: current
				},
				null,
			)
			if (borrowed) {
				if (apiKey === undefined) {
					apiKey = borrowed.credential.accessToken
					oauth = {
						refreshToken: borrowed.credential.refreshToken,
						expiresAt: borrowed.credential.expiresAt,
						origin: borrowed.source.kind === 'claude-file' ? 'claude-file' : 'keychain',
						...(borrowed.source.kind === 'claude-file' ? { sourcePath: borrowed.source.path } : {}),
					}
				}
				sources.push(borrowed.source)
			}
			for (const candidate of borrowedCandidates) {
				if (candidate !== borrowed) sources.push(candidate.source)
			}
			if (storedCredential) {
				if (apiKey === undefined) {
					apiKey = storedCredential.accessToken
					oauth = {
						refreshToken: storedCredential.refreshToken,
						expiresAt: storedCredential.expiresAt,
						origin: 'stored',
					}
				}
				sources.push({
					kind: 'stored',
					path: credentialsPath(...(opts.home === undefined ? [] : [opts.home])),
				})
			}
		}

		if (id === 'codex' && (storedCodexCredential || usableCodexFileCredential)) {
			const credential = usableCodexFileCredential?.credential ?? storedCodexCredential
			if (!credential) throw new Error('unreachable')
			apiKey = credential.accessToken
			sources.push({
				kind: usableCodexFileCredential ? 'codex-file' : 'stored',
				path: usableCodexFileCredential
					? usableCodexFileCredential.path
					: credentialsPath(...(opts.home === undefined ? [] : [opts.home])),
			})
			codex = {
				accountId: credential.accountId,
				expiresAt: credential.expiresAt,
				origin: usableCodexFileCredential ? 'codex-file' : 'stored',
			}
			if (storedCodexCredential && usableCodexFileCredential) {
				sources.push({
					kind: 'stored',
					path: credentialsPath(...(opts.home === undefined ? [] : [opts.home])),
				})
			}
			for (const candidate of codexFileCredentials) {
				if (candidate !== usableCodexFileCredential) {
					sources.push({ kind: 'codex-file', path: candidate.path })
				}
			}
		}

		for (const envName of entry.envVars) {
			// Through the SDK's seam rather than a direct `env[envName]`. The
			// read is identical; what changes is that a host embedding the SDK
			// without this CLI can now answer the same question with its own
			// provider, and that the "is this a credential" vocabulary is the
			// one the host-bash scrub uses rather than a third table beside it.
			const resolved = await credentials.resolve(envName)
			if (resolved) {
				if (apiKey === undefined) apiKey = resolved.value
				sources.push({ kind: 'env', envName })
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
				...(codex ? { codex } : {}),
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
		const res = await fetchFn(url, {
			method: 'GET',
			signal: controller.signal,
		})
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
