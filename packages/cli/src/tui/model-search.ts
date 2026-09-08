import type { ModelChoice } from './model-choices.js'

/** Match every word against IDs and names, retaining catalogue order and identity. */
export function filterModelChoices(
	choices: readonly ModelChoice[],
	query: string,
): readonly ModelChoice[] {
	const words = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean)
	if (words.length === 0) return choices
	return choices.filter((choice) => {
		const text = `${choice.id} ${choice.label}`.normalize('NFKC').toLowerCase()
		return words.every((word) => text.includes(word))
	})
}
