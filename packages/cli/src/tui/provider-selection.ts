import type { Preferences, ProviderChoice } from '../integrations/providers/index.js'

/** Replace the primary while retaining the operator's remaining configuration. */
export function selectPrimaryProvider(
	previous: Preferences | null,
	selection: ProviderChoice,
): Preferences {
	const pinned = previous?.providers.find((provider) => provider.id === selection.id)
	const model = selection.model ?? pinned?.model
	return {
		...(previous ?? { subagents: { active: [] } }),
		version: 3,
		providers: [
			{ id: selection.id, ...(model !== undefined ? { model } : {}) },
			...(previous?.providers
				.slice(1)
				.filter((provider) => provider.id !== selection.id || provider.model !== model) ?? []),
		],
	}
}
