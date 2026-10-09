import type { ProviderConnectionView, ProviderView } from './protocol.js'

/** Only providers a person connected can answer a message; the keyless free tier is offered, not counted. */
export function usableProviders(view: ProviderView): ProviderView['available'] {
	return view.available.filter((provider) => provider.anonymous !== true)
}

const STATES = new Set(['connected', 'free', 'not-connected'])
const HOWS = new Set([
	'environment',
	'saved-key',
	'claude-sign-in',
	'codex-sign-in',
	'gemini-sign-in',
	'namzu-sign-in',
	'opencode-key',
	'local',
	'free',
])

/**
 * The CLI's provider list, checked and trimmed to known fields. Anything unexpected is
 * dropped rather than forwarded, so a stray field can never carry a credential to the window.
 */
export function readProviderConnections(value: unknown): ProviderConnectionView[] {
	const list = (value as { providers?: unknown } | null)?.providers
	if (!Array.isArray(list) || list.length > 200)
		throw new Error('Namzu returned an invalid provider list.')
	return list.map((row): ProviderConnectionView => {
		const item = row as Record<string, unknown> | null
		if (
			!item ||
			typeof item.id !== 'string' ||
			item.id.length > 100 ||
			typeof item.label !== 'string' ||
			item.label.length > 200 ||
			typeof item.state !== 'string' ||
			!STATES.has(item.state) ||
			typeof item.canSaveKey !== 'boolean' ||
			typeof item.hasSavedKey !== 'boolean'
		)
			throw new Error('Namzu returned an invalid provider list.')
		return {
			id: item.id,
			label: item.label,
			state: item.state as ProviderConnectionView['state'],
			...(typeof item.how === 'string' && HOWS.has(item.how)
				? { how: item.how as NonNullable<ProviderConnectionView['how']> }
				: {}),
			...(typeof item.envName === 'string' && item.envName.length <= 200
				? { envName: item.envName }
				: {}),
			canSaveKey: item.canSaveKey,
			hasSavedKey: item.hasSavedKey,
			...(typeof item.help === 'string' && item.help.length <= 400 ? { help: item.help } : {}),
		}
	})
}
