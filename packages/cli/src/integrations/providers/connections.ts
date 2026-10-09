/**
 * Which providers this machine can use, and how, in words an application can show.
 *
 * Read by the desktop's Settings ▸ Models. It reads discovery (the same function
 * a terminal session starts from), so "connected" here means exactly what it
 * means when a turn is sent. Nothing in a view carries a credential.
 *
 * Saving a key goes to Namzu's own private store (`api-keys.json`, or the
 * Gemini file for Google), the one discovery reads back. The environment still
 * takes precedence, so a person who exported a key is never silently overridden.
 */

import { hasApiCredential } from './access.js'
import {
	clearStoredApiKey,
	clearStoredGeminiApiKey,
	readStoredApiKey,
	readStoredGeminiApiKey,
	writeStoredApiKey,
	writeStoredGeminiApiKey,
} from './credential-store.js'
import { type DetectedProvider, type DiscoverOptions, discoverProviders } from './discover.js'
import { ALL_PROVIDER_IDS, PROVIDER_REGISTRY, type ProviderId } from './registry.js'

export type ProviderConnectionHow =
	| 'environment'
	| 'saved-key'
	| 'claude-sign-in'
	| 'codex-sign-in'
	| 'gemini-sign-in'
	| 'namzu-sign-in'
	| 'opencode-key'
	| 'local'
	| 'free'

export interface ProviderConnection {
	id: string
	label: string
	/** `free` is the anonymous tier: listed, but not a connection. */
	state: 'connected' | 'free' | 'not-connected'
	how?: ProviderConnectionHow
	/** The environment variable that supplied the key; a name, never a value. */
	envName?: string
	/** A person can paste a key for this provider. */
	canSaveKey: boolean
	/** Namzu holds a pasted key that Remove would delete. */
	hasSavedKey: boolean
	/** Plain next step for a provider that is signed in rather than keyed. */
	help?: string
}

const MAX_KEY_LENGTH = 4096

/** The pasted text, trimmed, or a plain-language refusal. */
export function checkPastedKey(value: unknown): string {
	if (typeof value !== 'string') throw new Error('Paste an API key.')
	const key = value.trim()
	if (!key) throw new Error('Paste an API key.')
	if (key.length > MAX_KEY_LENGTH) throw new Error('That is too long to be an API key.')
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
	if (/[\u0000-\u001f\u007f\s]/.test(key))
		throw new Error('An API key has no spaces or line breaks.')
	return key
}

export function typedKeyProvider(id: unknown): ProviderId {
	if (typeof id !== 'string' || !(ALL_PROVIDER_IDS as readonly string[]).includes(id))
		throw new Error('Choose one of the listed providers.')
	const entry = PROVIDER_REGISTRY[id as ProviderId]
	if (!entry.constructible || !entry.acceptsTypedCredential)
		throw new Error(`${entry.label} is signed in rather than keyed. Use its sign-in instead.`)
	return entry.id
}

function howOf(detected: DetectedProvider): {
	how: ProviderConnectionHow
	envName?: string
} {
	const source = detected.source
	switch (source.kind) {
		case 'env':
			return { how: 'environment', envName: source.envName }
		case 'stored-api-key':
		case 'stored-gemini-key':
			return { how: 'saved-key' }
		case 'claude-file':
		case 'keychain':
			return { how: 'claude-sign-in' }
		case 'codex-file':
			return { how: 'codex-sign-in' }
		case 'gemini-file':
			return { how: 'gemini-sign-in' }
		case 'stored':
			return { how: 'namzu-sign-in' }
		case 'opencode-file':
			return { how: 'opencode-key' }
		case 'probe':
		case 'session':
			return { how: 'local' }
		case 'public':
			return { how: 'free' }
	}
}

function helpFor(id: ProviderId): string | undefined {
	switch (id) {
		case 'anthropic':
			return 'Or sign in with Claude Code, or from the Namzu tab, and Namzu uses that sign-in.'
		case 'codex':
			return 'Sign in with Codex, or from the Namzu tab, and Namzu uses that sign-in.'
		default:
			return undefined
	}
}

export function connectionsFrom(
	detected: readonly DetectedProvider[],
	home?: string,
): ProviderConnection[] {
	const rows: ProviderConnection[] = []
	for (const id of ALL_PROVIDER_IDS) {
		const entry = PROVIDER_REGISTRY[id]
		if (!entry.constructible) continue
		const found = detected.find((item) => item.entry.id === id)
		const anonymous = Boolean(found && id === 'zen' && !hasApiCredential(entry, found.apiKey))
		const hasSavedKey =
			entry.acceptsTypedCredential &&
			(id === 'google' ? readStoredGeminiApiKey(home) : readStoredApiKey(id, home)) !== null
		const how = found ? howOf(found) : undefined
		const help = helpFor(id)
		rows.push({
			id,
			label: entry.label,
			state: !found ? 'not-connected' : anonymous ? 'free' : 'connected',
			...(how && !anonymous ? how : {}),
			...(anonymous ? { how: 'free' as const } : {}),
			canSaveKey: entry.acceptsTypedCredential,
			hasSavedKey,
			...(help ? { help } : {}),
		})
	}
	// Connected first, then the rest in registry order.
	const rank = (row: ProviderConnection) =>
		row.state === 'connected' ? 0 : row.state === 'free' ? 1 : 2
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
		.map(({ row }) => row)
}

export async function listProviderConnections(
	options: DiscoverOptions = {},
): Promise<ProviderConnection[]> {
	return connectionsFrom(await discoverProviders(options), options.home)
}

export function saveProviderKey(id: unknown, value: unknown, home?: string): ProviderId {
	const provider = typedKeyProvider(id)
	const key = checkPastedKey(value)
	if (provider === 'google') writeStoredGeminiApiKey(key, home)
	else writeStoredApiKey(provider, key, home)
	return provider
}

export function removeProviderKey(id: unknown, home?: string): ProviderId {
	const provider = typedKeyProvider(id)
	if (provider === 'google') clearStoredGeminiApiKey(home)
	else clearStoredApiKey(provider, home)
	return provider
}
