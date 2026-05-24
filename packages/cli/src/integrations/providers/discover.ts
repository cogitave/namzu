/**
 * Credential discoverer for LLM provider clients.
 *
 * For each entry in `PROVIDER_REGISTRY`, ask three questions in order:
 *   1. Is one of its env vars set in `process.env`?
 *   2. Does clawtool's secrets.toml carry one of its env vars?
 *   3. Is the probe URL (if any) reachable right now?
 *
 * The first positive answer per provider wins; subsequent sources are
 * recorded as "also available from" so the picker can show alternatives
 * (e.g. anthropic via env, also available in `[secrets.personal]`).
 *
 * Discovery is non-throwing. Network probes have short timeouts. The
 * picker can render immediately and refine if discovery completes later.
 */

import { readClaudeCodeKeychainCredential } from './keychain.js'
import { PROVIDER_REGISTRY, type ProviderId, type ProviderRegistryEntry } from './registry.js'
import { readClawtoolSecrets } from './secrets.js'

export type DetectionSource =
	| { readonly kind: 'env'; readonly envName: string }
	| { readonly kind: 'secrets-toml'; readonly envName: string; readonly scope: string }
	| { readonly kind: 'probe'; readonly url: string }
	| { readonly kind: 'keychain'; readonly service: string }

export interface DetectedProvider {
	readonly entry: ProviderRegistryEntry
	/** First positive source (used by default). */
	readonly source: DetectionSource
	/** Resolved API key, if the source carried one. */
	readonly apiKey?: string
	/** Resolved base URL (overrides the registry default if set). */
	readonly baseUrl?: string
	/** Other sources that also satisfy this provider — informational. */
	readonly alternatives: readonly DetectionSource[]
}

export interface DiscoverOptions {
	/** Override `process.env` for tests. */
	readonly env?: NodeJS.ProcessEnv
	/** Override `homedir()` for tests (read clawtool secrets from a fixture). */
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
	const secrets = readClawtoolSecrets(opts.home)
	const detected: DetectedProvider[] = []

	// macOS-only: read Claude Code's OAuth credential from the login
	// Keychain once. Only anthropic consumes it, but we scan up front so
	// the loop body stays uniform.
	const claudeKeychain = opts.skipKeychain ? null : readClaudeCodeKeychainCredential()

	for (const id of Object.keys(PROVIDER_REGISTRY) as readonly ProviderId[]) {
		const entry = PROVIDER_REGISTRY[id]
		const sources: DetectionSource[] = []
		let apiKey: string | undefined
		for (const envName of entry.envVars) {
			const v = env[envName]
			if (v && v.length > 0) {
				if (apiKey === undefined) apiKey = v
				sources.push({ kind: 'env', envName })
			}
		}
		for (const cand of secrets) {
			if (entry.envVars.includes(cand.envName)) {
				if (apiKey === undefined) apiKey = cand.value
				sources.push({ kind: 'secrets-toml', envName: cand.envName, scope: cand.scope })
			}
		}
		if (id === 'anthropic' && claudeKeychain) {
			if (apiKey === undefined) apiKey = claudeKeychain.accessToken
			sources.push({ kind: 'keychain', service: 'Claude Code-credentials' })
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
				alternatives: sources.slice(1),
			})
			continue
		}
		// Probe-only providers (Ollama, LM Studio): include even when probe
		// fails so the picker can show "(not running)" and the user knows
		// they could start the server. Local providers with no apiKey need
		// only the URL to be addressable.
		if (!entry.requiresApiKey && entry.probeUrl && !opts.skipProbes === false) {
			// `skipProbes === true` reaches this branch; surface as not-detected,
			// no row in the picker, so user isn't confused by phantom entries.
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
