/**
 * Put a driver package into the SDK's `ProviderRegistry`, once per process.
 *
 * This is the only place the wired driver packages are imported, so it decides
 * what a `namzu` invocation actually pulls in and when. The imports are dynamic
 * for that reason: a run on one provider does not load the other three, and a
 * command that never touches a model loads none.
 *
 * ## Why it lives here rather than in the session module
 *
 * It used to be module-private inside the interactive session, which made
 * reading what a provider DECLARES a privilege of having started a session.
 * Registration is a precondition of that read — the SDK cannot report the
 * capabilities of a package nobody imported — so `namzu doctor`, whose whole
 * job is to answer questions about the setup before a session exists, could not
 * ask. The alternative was for the diagnostic to import the session module and
 * with it the query runtime, the subagent runtime, MCP, memory and skills, for
 * one map lookup.
 *
 * So it sits beside `PROVIDER_REGISTRY`, which is the data it switches over,
 * and both the session and the doctor reach it without either importing the
 * other.
 *
 * ## One set, and that is load-bearing
 *
 * `registered` makes registration idempotent. It must exist exactly once: two
 * copies would each believe a provider was unregistered and register it twice,
 * and the SDK's registry rejects that with a duplicate-provider error. That is
 * the whole reason this is a module rather than a function anyone may copy —
 * the state is the API as much as the function is.
 */

import { ProviderRegistry } from '@namzu/sdk'
import type { ResolvedProviderCapabilities } from '@namzu/sdk'
import { resolveProviderCapabilities } from '@namzu/sdk'

import type { MemberCapabilities } from './chain-capabilities.js'
import type { ProviderChoice } from './preferences.js'
import { PROVIDER_REGISTRY, type ProviderId, unsupportedProviderMessage } from './registry.js'

const registered = new Set<ProviderId>()

/**
 * Import and register the driver for `id`, unless it is already registered.
 *
 * Throws for a provider this build ships no driver for — the arms below are
 * exactly the entries flagged `constructible` in `PROVIDER_REGISTRY`, and
 * `register.test.ts` holds the two in agreement.
 *
 * **This is the last line of defence, not the first.** By the time a session
 * reaches it the operator has already chosen, and a refusal here lands them on
 * a screen with a disabled composer where the advice "pick another" cannot be
 * followed. The refusals that matter are earlier: `describeInvalidChain`
 * refuses a saved primary at READ time, which routes to the picker with the
 * reason, and the picker declines to offer the row at all.
 */
export async function ensureRegistered(id: ProviderId): Promise<void> {
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
			throw new Error(unsupportedProviderMessage(id))
	}
	registered.add(id)
}

/**
 * Has this provider's driver been registered in THIS process?
 *
 * Read by the chain builder to skip a member whose registration failed, so the
 * failure is reported once — as an unresolved capability — rather than twice in
 * different words.
 */
export function isRegistered(id: ProviderId): boolean {
	return registered.has(id)
}

/**
 * What each member of the chain DECLARES it can do.
 *
 * Type-level, via the registry, so nothing is constructed and no credential is
 * needed — which is the whole point: the member most worth checking is the
 * fallback nobody has set up yet, and a check that demanded a key would be
 * unusable in exactly that case.
 *
 * A member that cannot be registered is reported as unresolved rather than
 * assumed to agree. Registration is also why this cannot be a pure function: a
 * provider package is only imported when something needs it.
 */
export async function resolveChainCapabilities(
	members: readonly ProviderChoice[],
): Promise<readonly MemberCapabilities[]> {
	const out: MemberCapabilities[] = []
	for (const member of members) {
		if (!(member.id in PROVIDER_REGISTRY)) {
			out.push({ kind: 'unresolved', reason: `"${member.id}" is not a provider namzu knows` })
			continue
		}
		try {
			await ensureRegistered(member.id)
			out.push({
				kind: 'known',
				capabilities: resolveProviderCapabilities({
					capabilities: ProviderRegistry.getCapabilities(member.id),
				} as { capabilities: ResolvedProviderCapabilities | undefined }),
			})
		} catch (err) {
			out.push({
				kind: 'unresolved',
				reason: err instanceof Error ? err.message : String(err),
			})
		}
	}
	return out
}
