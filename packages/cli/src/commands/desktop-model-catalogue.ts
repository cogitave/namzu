import type { ModelListing } from '../tui/agent.js'

/** A desktop catalogue reports provider rows, never invented defaults or saved pins. */
export function desktopModelCatalogue(
	listing: ModelListing,
	defaultModel: string,
	currentModel: string | undefined,
	allowModel: (id: string) => boolean,
): {
	models: { id: string; label: string; note?: string }[]
	notice: string | null
} {
	if (listing.kind !== 'ok') {
		const notice =
			listing.kind === 'unsupported'
				? 'This provider does not publish a model list.'
				: listing.kind === 'timeout'
					? 'The provider catalogue did not answer in time. Refresh the list to retry.'
					: listing.failure === 'authentication'
						? 'The provider rejected its credential. Sign in or configure this provider, then refresh the list.'
						: listing.failure === 'credential-unavailable'
							? 'The selected sign-in is no longer available on this device. Refresh provider discovery or choose another provider.'
							: 'The provider catalogue could not be loaded. Refresh the list to retry.'
		return { models: [], notice }
	}
	const seen = new Set<string>()
	const models: { id: string; label: string; note?: string }[] = []
	for (const model of listing.models) {
		if (
			!model.id ||
			model.id.length > 400 ||
			/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(model.id) ||
			seen.has(model.id) ||
			!allowModel(model.id)
		)
			continue
		seen.add(model.id)
		const notes: string[] = []
		if (model.id === defaultModel) notes.push('Namzu default')
		if (model.inputModalities?.includes('image')) notes.push('image input')
		if (model.inputPrice === 0 && model.outputPrice === 0 && !/\bfree\b/i.test(model.name))
			notes.push('free')
		models.push({
			id: model.id,
			label: (model.name || model.id).slice(0, 400),
			...(notes.length ? { note: `(${notes.join(' · ')})` } : {}),
		})
	}
	const selectedUnavailable = currentModel !== undefined && !seen.has(currentModel)
	return {
		models: models.slice(0, 4096),
		notice:
			models.length > 4096
				? 'Showing the first 4,096 models.'
				: selectedUnavailable
					? 'The selected model is not in this catalogue. Choose a listed model or another provider.'
					: models.length === 0
						? 'This provider returned no selectable models for this access path.'
						: null,
	}
}
