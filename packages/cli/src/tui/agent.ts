/**
 * Thin agent session for the M3 TUI.
 *
 * Goes directly to `provider.chatStream()` (per-delta tokens) rather than
 * the full `@namzu/sdk` `query()` orchestrator — query() is the tool-aware
 * iteration loop which lands in M3 Phase D (tool dispatch + permission).
 * For Phase C we just need "user types → model streams reply". That's
 * `chatStream()` directly.
 *
 * The session is **stateless across turns**: the TUI owns the message
 * history and passes the full array on every `send()`. Provider hydration
 * happens once at construction; if no profile is configured we return an
 * `EmptyAgentSession` whose `send()` yields a single error event so the
 * UI can render an actionable "configure first" hint.
 */

import { registerAnthropic } from '@namzu/anthropic'
import { ProviderRegistry } from '@namzu/sdk'
import type { Message } from '@namzu/sdk'

import {
	type ProviderProfile,
	findDefault,
	readProfiles,
	resolveApiKey,
} from '../integrations/providers/index.js'

let providersRegistered = false

function ensureProvidersRegistered(): void {
	if (providersRegistered) return
	registerAnthropic()
	providersRegistered = true
}

export type AgentEvent =
	| { readonly kind: 'delta'; readonly text: string }
	| { readonly kind: 'done'; readonly finishReason?: string }
	| { readonly kind: 'error'; readonly message: string }

export interface AgentSession {
	readonly hasProvider: boolean
	readonly providerSummary: string | null
	readonly modelSummary: string | null
	readonly errorHint: string | null
	send(messages: readonly Message[], abort?: AbortSignal): AsyncIterable<AgentEvent>
}

export function createAgentSession(): AgentSession {
	const profiles = readProfiles()
	const profile = findDefault(profiles) ?? profiles[0] ?? null
	if (!profile) {
		return emptySession(
			'No provider configured. Run `namzu providers add <name> --type anthropic --api-key sk-ant-... --default`.',
		)
	}
	if (profile.type !== 'anthropic') {
		return emptySession(
			`Provider type "${profile.type}" is not wired in M3 yet — only "anthropic" lands in Phase C. Other providers (openai, openrouter, ollama, …) are M3 follow-up work.`,
		)
	}
	const apiKey = resolveApiKey(profile)
	if (!apiKey) {
		return emptySession(
			`Default profile "${profile.name}" has no API key. Set ANTHROPIC_API_KEY in your environment or run \`namzu providers add ${profile.name} --type anthropic --api-key sk-ant-... --default\`.`,
		)
	}
	const model = profile.model ?? null
	if (!model) {
		return emptySession(
			`Default profile "${profile.name}" has no \`model\` set. Use e.g. \`--model claude-opus-4-5\` when adding the profile, or edit ~/.namzu/providers.json.`,
		)
	}
	return buildLiveSession(profile, apiKey, model)
}

function emptySession(errorHint: string): AgentSession {
	return {
		hasProvider: false,
		providerSummary: null,
		modelSummary: null,
		errorHint,
		async *send() {
			yield { kind: 'error', message: errorHint }
		},
	}
}

function buildLiveSession(profile: ProviderProfile, apiKey: string, model: string): AgentSession {
	ensureProvidersRegistered()
	const anthropicProfile = profile as Extract<ProviderProfile, { type: 'anthropic' }>
	const { provider } = ProviderRegistry.create({
		type: 'anthropic',
		apiKey,
		baseURL: anthropicProfile.baseUrl,
		model,
	})
	return {
		hasProvider: true,
		providerSummary: `${profile.name} (${profile.type})`,
		modelSummary: model,
		errorHint: null,
		async *send(messages, abort) {
			try {
				const stream = provider.chatStream({
					model,
					messages: [...messages],
					maxTokens: 4096,
				})
				for await (const chunk of stream) {
					if (abort?.aborted) {
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
		},
	}
}
