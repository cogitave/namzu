/**
 * TUI agent session — provider-direct.
 *
 * Reads the picker selection (preferences.json), looks up the chosen
 * provider in the declarative registry, lazy-loads the matching
 * `@namzu/<type>` package, constructs the SDK provider, and exposes
 * `send(messages, signal?) → AsyncIterable<AgentEvent>` over the
 * provider's per-delta `chatStream()`.
 *
 * The TUI owns conversation history and passes the full `Message[]`
 * on every turn (stateless session). Empty / partial states (no
 * credentials, no preferences, no matching detected provider) return
 * an `emptySession()` whose `send()` yields a single error event so
 * the UI renders an actionable hint rather than crashing.
 */

import type { LLMProvider, Message } from '@namzu/sdk'
import { ProviderRegistry } from '@namzu/sdk'

import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
	type ProviderId,
	discoverProviders,
	findDetected,
	isAnthropicOAuthToken,
	readPreferences,
} from '../integrations/providers/index.js'

export type AgentEvent =
	| { readonly kind: 'delta'; readonly text: string }
	| { readonly kind: 'done'; readonly finishReason?: string }
	| { readonly kind: 'error'; readonly message: string }

export interface AgentSession {
	readonly hasProvider: boolean
	readonly providerSummary: string | null
	readonly modelSummary: string | null
	readonly errorHint: string | null
	send(messages: readonly Message[], signal?: AbortSignal): AsyncIterable<AgentEvent>
}

export interface AgentSessionContext {
	readonly preferences: Preferences | null
	readonly needsRepickReason: string | null
	readonly detected: readonly DetectedProvider[]
}

/**
 * Read preferences + run discovery once. Returned context drives the
 * App's lifecycle decision: ready / picker / unhealthy.
 */
export async function probeAgentSession(): Promise<AgentSessionContext> {
	const read = readPreferences()
	const detected = await discoverProviders()
	switch (read.status) {
		case 'ok':
			return { preferences: read.prefs, needsRepickReason: null, detected }
		case 'missing':
			return { preferences: null, needsRepickReason: null, detected }
		case 'needs-repick':
			return { preferences: null, needsRepickReason: read.reason, detected }
	}
}

const registered = new Set<ProviderId>()

async function ensureRegistered(id: ProviderId): Promise<void> {
	if (registered.has(id)) return
	switch (id) {
		case 'anthropic': {
			const mod = await import('@namzu/anthropic')
			mod.registerAnthropic()
			break
		}
		case 'openai': {
			const mod = await import('@namzu/openai')
			mod.registerOpenAI()
			break
		}
		case 'openrouter': {
			const mod = await import('@namzu/openrouter')
			mod.registerOpenRouter()
			break
		}
		case 'ollama': {
			const mod = await import('@namzu/ollama')
			mod.registerOllama()
			break
		}
		default:
			throw new Error(`provider "${id}" is not wired yet; pick another or wait for support`)
	}
	registered.add(id)
}

export async function createAgentSession(
	prefs: Preferences,
	detected: readonly DetectedProvider[],
): Promise<AgentSession> {
	const entry = PROVIDER_REGISTRY[prefs.provider]
	if (!entry) {
		return emptySession(`Unknown provider "${prefs.provider}" — pick another.`)
	}
	const det = findDetected(detected, prefs.provider)
	if (entry.requiresApiKey && (!det || !det.apiKey)) {
		return emptySession(
			`No credential found for ${entry.label}. Set one of: ${entry.envVars.join(', ')} — or pick another provider.`,
		)
	}
	try {
		await ensureRegistered(prefs.provider)
	} catch (err) {
		return emptySession(err instanceof Error ? err.message : String(err))
	}
	const model = prefs.model ?? entry.defaultModel
	let provider: LLMProvider
	try {
		provider = constructProvider(prefs.provider, det, model)
	} catch (err) {
		return emptySession(
			`Failed to construct ${entry.label}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	return {
		hasProvider: true,
		providerSummary: entry.label,
		modelSummary: model,
		errorHint: null,
		send: (messages, signal) => streamTurn(provider, model, messages, signal),
	}
}

function constructProvider(
	id: ProviderId,
	det: DetectedProvider | null,
	model: string,
): LLMProvider {
	switch (id) {
		case 'anthropic': {
			const token = det?.apiKey ?? ''
			const isOAuth = token.length > 0 && isAnthropicOAuthToken(token)
			const { provider } = ProviderRegistry.create({
				type: 'anthropic',
				...(isOAuth ? { authToken: token } : { apiKey: token }),
				baseURL: det?.baseUrl,
				model,
			})
			return provider
		}
		case 'openai': {
			const { provider } = ProviderRegistry.create({
				type: 'openai',
				apiKey: det?.apiKey ?? '',
				baseURL: det?.baseUrl,
				model,
			})
			return provider
		}
		case 'openrouter': {
			const { provider } = ProviderRegistry.create({
				type: 'openrouter',
				apiKey: det?.apiKey ?? '',
				baseUrl: det?.baseUrl,
			})
			return provider
		}
		case 'ollama': {
			const { provider } = ProviderRegistry.create({
				type: 'ollama',
				host: det?.baseUrl,
				model,
			})
			return provider
		}
		default:
			throw new Error(`provider "${id}" is not yet wired to ProviderRegistry`)
	}
}

async function* streamTurn(
	provider: LLMProvider,
	model: string,
	messages: readonly Message[],
	signal: AbortSignal | undefined,
): AsyncIterable<AgentEvent> {
	try {
		const stream = provider.chatStream({ model, messages: [...messages], maxTokens: 4096 })
		for await (const chunk of stream) {
			if (signal?.aborted) {
				yield { kind: 'error', message: 'aborted' }
				return
			}
			if (chunk.error) {
				yield { kind: 'error', message: chunk.error }
				return
			}
			if (chunk.delta.content) {
				yield { kind: 'delta', text: chunk.delta.content }
			}
			if (chunk.finishReason) {
				yield { kind: 'done', finishReason: chunk.finishReason }
				return
			}
		}
		yield { kind: 'done' }
	} catch (err) {
		yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
	}
}

function emptySession(errorHint: string): AgentSession {
	return {
		hasProvider: false,
		providerSummary: null,
		modelSummary: null,
		errorHint,
		send: async function* () {
			yield { kind: 'error' as const, message: errorHint }
		},
	}
}
