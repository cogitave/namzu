/** Pal conversation admission shared by the terminal's startup and navigation. */
import type { Preferences, ProviderId } from '../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../integrations/providers/index.js'
import { type PalSessionEnvironment, palSessionEnvironment } from './agent-session.js'
import { palConversationBinding } from './conversations.js'
import { getCliPalRuntime } from './environment.js'
import { type Pal, palAtWorkspace } from './store.js'

export function tuiPalOwner(cwd: string, expectedId?: string): Pal | null {
	const pal = palAtWorkspace(cwd)
	if (expectedId && pal?.id !== expectedId)
		throw new Error('This workspace does not belong to the requested Pal.')
	return pal
}

export async function tuiPalDefinition(
	cwd: string,
	sessionId: string,
	expectedId?: string,
): Promise<Pal | null> {
	const owner = tuiPalOwner(cwd, expectedId)
	if (!owner) return null
	const binding = await palConversationBinding(cwd, sessionId)
	if (!binding || binding.pal.id !== owner.id)
		throw new Error('This conversation does not belong to this Pal.')
	if (binding.pal.paused) throw new Error('This Pal is paused. Resume it before starting work.')
	return binding.definition
}

export function tuiPalPreferences(
	definition: Pal,
	fallback: Preferences | null,
): Preferences | null {
	if (!definition.model) return fallback
	const { provider, model } = definition.model
	if (!Object.hasOwn(PROVIDER_REGISTRY, provider))
		throw new Error('The Pal model provider is unavailable in this CLI.')
	return {
		version: 3,
		providers: [{ id: provider as ProviderId, model }],
		subagents: { active: [] },
	}
}

export async function tuiPalEnvironment(
	definition: Pal,
	sessionId: string,
	signal?: AbortSignal,
): Promise<PalSessionEnvironment> {
	const runtime = await getCliPalRuntime()
	signal?.throwIfAborted()
	return palSessionEnvironment(runtime, definition, sessionId)
}

/** Directed work retains mandatory guest admission; ordinary chat uses the path above. */
export async function tuiPalWorkEnvironment(
	definition: Pal,
	sessionId: string,
	signal?: AbortSignal,
): Promise<PalSessionEnvironment> {
	const runtime = await getCliPalRuntime()
	const lease = await runtime.startComputer(definition.id, signal)
	const binding = palSessionEnvironment(runtime, definition, sessionId)
	return { definition: binding.definition, lease, admit: binding.admit }
}
