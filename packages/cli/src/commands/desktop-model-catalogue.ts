import { codexModelLabel } from '../integrations/harness/codex-protocol.js'
import type { ModelGroup, ModelListing } from '../tui/agent.js'
import { withKeyNote } from '../tui/model-choices.js'

/**
 * A GPT display name written "GPT-5.6-Sol" reads "GPT-5.6 Sol", as the Codex app writes it.
 * Only names that start with "GPT-" change: ids, "gpt-4o", "o3-mini", "qwen2.5-coder" and
 * "Opus 5.5" pass through, and so does a raw id used as its own label.
 */
export function modelListLabel(name: string, id: string): string {
	return name !== id && name.startsWith('GPT-') ? codexModelLabel(name) : name
}

export interface DesktopModelRow {
	id: string
	label: string
	note?: string
	default?: true
	/** The source says this model is current; the picker folds the rest under older models. */
	current?: true
	/** Zen only; the picker draws a heading where it changes. Absent when no price is published. */
	group?: ModelGroup
}

/** A desktop catalogue reports provider rows, never invented defaults or saved pins. */
export function desktopModelCatalogue(
	listing: ModelListing,
	defaultModel: string,
	currentModel: string | undefined,
	allowModel: (id: string) => boolean,
): {
	models: DesktopModelRow[]
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
	const models: DesktopModelRow[] = []
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
		if (model.inputModalities?.includes('image')) notes.push('image input')
		if (model.inputPrice === 0 && model.outputPrice === 0 && !/\bfree\b/i.test(model.name))
			notes.push('free')
		if (model.limitsVerified === false) notes.push('Limits not published yet')
		models.push({
			id: model.id,
			label: modelListLabel(model.name || model.id, model.id).slice(0, 400),
			...(notes.length ? { note: `(${notes.join(' · ')})` } : {}),
			...(model.group ? { group: model.group } : {}),
			...(model.id === defaultModel ? { default: true as const } : {}),
		})
	}
	// The headings say which rows need a key. A list that cannot show both headings (only one
	// group, or none) keeps the note on those rows so the fact is not lost.
	if (!models.some((m) => m.group === 'free') || !models.some((m) => m.group === 'key')) {
		for (const row of models) {
			if (row.group !== 'key') continue
			row.note = withKeyNote(row.note)
		}
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
