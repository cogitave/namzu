/**
 * TUI agent session — clawtool-backed.
 *
 * As of ses_005, every dispatch goes through clawtool's
 * `POST /v1/send_message` against the user's saved default instance.
 * Credentials, OAuth flows, and bridge wiring live in clawtool; namzu
 * only needs the preference (which instance, with what context).
 *
 * The previous direct `provider.chatStream()` path (ses_004 Phase C)
 * was removed — it duplicated clawtool's credential layer. Raw-API
 * fallback (when the user has only their own API key and no host CLI
 * wired) is a future escape hatch via the existing M2
 * `~/.namzu/providers.json` store; ses_005 does not implement that
 * fallback to keep the surface tight.
 */

import {
	type Agent,
	type DispatchEvent,
	type Preferences,
	listAgents,
	readPreferences,
	sendMessage,
} from '../integrations/clawtool/index.js'

export type AgentEvent =
	| { readonly kind: 'delta'; readonly text: string }
	| { readonly kind: 'done'; readonly finishReason?: string }
	| { readonly kind: 'error'; readonly message: string }

export interface AgentSessionContext {
	readonly preferences: Preferences | null
	readonly availableAgents: readonly Agent[]
}

export interface AgentSession {
	readonly hasProvider: boolean
	readonly providerSummary: string | null
	readonly modelSummary: string | null
	readonly errorHint: string | null
	send(userMessage: string, signal?: AbortSignal): AsyncIterable<AgentEvent>
}

/**
 * Probe the environment (preferences file + clawtool agents) and return
 * the data the TUI needs to decide between "go straight to chat" and
 * "show the picker first". Cheap — single HTTP call (or zero, if
 * clawtool isn't running yet and preferences already exist).
 */
export async function probeAgentSession(): Promise<AgentSessionContext> {
	const preferences = readPreferences()
	let availableAgents: readonly Agent[] = []
	try {
		availableAgents = await listAgents()
	} catch {
		availableAgents = []
	}
	return { preferences, availableAgents }
}

export function createAgentSession(prefs: Preferences | null): AgentSession {
	if (!prefs) {
		return emptySession('No preferences set — run the first-run picker (or restart namzu).')
	}
	return {
		hasProvider: true,
		providerSummary: prefs.default,
		modelSummary: prefs.active.length > 1 ? `+ ${prefs.active.length - 1} active subagents` : null,
		errorHint: null,
		send: (userMessage: string, signal?: AbortSignal) =>
			streamTurn(prefs.default, userMessage, signal),
	}
}

async function* streamTurn(
	instance: string,
	prompt: string,
	signal: AbortSignal | undefined,
): AsyncIterable<AgentEvent> {
	const stream = sendMessage({ instance, prompt, signal })
	for await (const event of stream) {
		yield mapDispatchEvent(event)
	}
}

function mapDispatchEvent(event: DispatchEvent): AgentEvent {
	switch (event.kind) {
		case 'delta':
			return { kind: 'delta', text: event.text }
		case 'done':
			return { kind: 'done' }
		case 'error':
			return { kind: 'error', message: event.message }
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
