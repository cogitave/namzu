import type { ProviderView } from '../shared/protocol.js'

/** A provider's product name without its qualifier: "Ollama (local)" reads "Ollama". */
function product(label: string): string {
	return label.replace(/\s*\(.*\)\s*$/, '').trim() || label
}

/**
 * The quiet line that says what Namzu picked on its own, in plain words (no ids, no variable
 * names). Only for a conversation where nothing was ever chosen and nothing was saved: a person
 * who chose a model, or whose settings name one, never sees it.
 */
export function automaticChoiceNote(
	providers: ProviderView,
	choice: { provider: string },
	unchosen: boolean,
): string | undefined {
	if (!unchosen || providers.selected?.automatic !== true) return undefined
	const picked = providers.available.find((item) => item.id === choice.provider)
	if (!picked) return undefined
	switch (picked.via) {
		case 'sign-in': {
			const account =
				picked.id === 'anthropic'
					? 'Claude'
					: picked.id === 'codex'
						? 'ChatGPT or Codex'
						: product(picked.label)
			return `Using your ${account} sign-in, found on this computer.`
		}
		case 'key':
			return `Using your ${product(picked.label)} key, found on this computer.`
		case 'local':
			return `Using ${product(picked.label)} running on this computer.`
		case 'free':
			return 'Using a free Zen model, so there is nothing to set up. You can connect your own provider in Settings.'
		default:
			return undefined
	}
}
