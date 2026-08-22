/**
 * What the model step of the picker offers, and what it says about the list.
 *
 * Pure on purpose. The TUI has no component tests, so logic that lives inside a
 * React component is logic nobody can check — and the owner is currently the
 * only person able to see this screen at all. Everything decidable is decided
 * here, and `Picker` is left as a thin caller.
 *
 * ## The default is always offered
 *
 * Every branch returns at least namzu's `defaultModel` for the provider. A screen that
 * can end with nothing selectable is a dead end for someone who came here to
 * get on with a task, and the default is exactly the value they would have got
 * by not visiting this step.
 *
 * ## The notice says which case it is
 *
 * "No models" is the same words for four different facts — the driver does not
 * implement listing, the provider publishes none, it timed out, it errored —
 * and three of them are not "this provider has no models". The timeout matters
 * most: the honest line is "it did not answer in time", because the operator
 * can retry that, and cannot retry a provider that genuinely has one model.
 */

import type { ModelListing } from './agent.js'

export interface ModelChoice {
	readonly id: string
	readonly label: string
	/** Shown beside the row. `(namzu default)` for the value namzu picks. */
	readonly note?: string
}

export interface ModelStep {
	readonly choices: readonly ModelChoice[]
	/**
	 * Why the list is short or absent, or `null` when it is a real full list.
	 *
	 * Rendered above the choices. `null` means the list is exactly what the
	 * provider said it was, so a notice would be noise.
	 */
	readonly notice: string | null
	/** Index of the row to start on: the current model, else the default. */
	readonly initialIndex: number
}

/**
 * Build the model step for one provider.
 *
 * @param defaultModel namzu's default for this provider, always offered.
 * @param listing What asking the provider produced.
 * @param currentModel The model in force now, if any — so re-opening the picker
 *   starts on what is already selected rather than resetting to the default.
 */
export function modelStep(
	defaultModel: string,
	listing: ModelListing,
	currentModel?: string,
): ModelStep {
	const fallback = (notice: string): ModelStep => ({
		choices: [{ id: defaultModel, label: defaultModel, note: '(namzu default)' }],
		notice,
		initialIndex: 0,
	})

	// "namzu's pick", never "its default", in all four. The row beside these
	// sentences is labelled `(namzu default)` because the value comes from
	// namzu's registry and not from the provider — and these said the opposite
	// on the same screen. It changes what an operator does about a model they
	// did not expect: whose default it is decides whether they go looking at the
	// provider, or pin `model` on this member in `preferences.json`.
	if (listing.kind === 'unsupported') {
		return fallback("This provider does not publish a model list. Showing namzu's pick for it.")
	}
	if (listing.kind === 'timeout') {
		// Deliberately not "no models". The provider may have hundreds; it just
		// did not answer inside 3s, and that is a retryable condition.
		return fallback(
			"The provider did not answer in time. Showing namzu's pick for it — try again to list.",
		)
	}
	if (listing.kind === 'failed') {
		return fallback(`Could not list models: ${listing.reason}. Showing namzu's pick for it.`)
	}
	if (listing.models.length === 0) {
		return fallback("The provider returned no models. Showing namzu's pick for it.")
	}

	// A real list. Make sure the default is in it and marked, because a list
	// that omits the value the user would otherwise get is missing the one entry
	// they can be sure works.
	const seen = new Set<string>()
	const choices: ModelChoice[] = []
	for (const m of listing.models) {
		if (seen.has(m.id)) continue
		seen.add(m.id)
		const notes: string[] = []
		if (m.id === defaultModel) notes.push('namzu default')
		if (m.inputModalities?.includes('image')) notes.push('image input')
		choices.push({
			id: m.id,
			label: m.name,
			...(notes.length > 0 ? { note: `(${notes.join(' · ')})` } : {}),
		})
	}
	if (!seen.has(defaultModel)) {
		choices.unshift({ id: defaultModel, label: defaultModel, note: '(namzu default)' })
	}

	const wanted = currentModel ?? defaultModel
	const idx = choices.findIndex((c) => c.id === wanted)

	return { choices, notice: null, initialIndex: idx >= 0 ? idx : 0 }
}
