import type { ModelChoice } from './model-choices.js'

/**
 * Match every word against IDs, names and notes, retaining catalogue order and
 * identity.
 *
 * The note is searched because it is where the facts a person is looking for
 * are written. `(free)` is one of them, and it is the only place some rows say
 * it: OpenRouter's zero-priced `google/lyria-3-pro-preview` carries the word
 * neither in its ID nor in its display name, so a search over those two fields
 * alone cannot find a free model that the screen is showing as free. Matching
 * what the screen shows is also the only rule an operator can predict by
 * looking at it, which is worth more than any word list this could invent.
 *
 * Nothing else moves. Every word must still appear, matching stays a
 * case-insensitive substring test after NFKC, an empty query still returns the
 * array it was given, and a match still returns the caller's own objects in
 * the order the catalogue produced them — callers hold a cursor against this
 * list and use the identity to keep a selection.
 */
export function filterModelChoices(
	choices: readonly ModelChoice[],
	query: string,
): readonly ModelChoice[] {
	const words = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean)
	if (words.length === 0) return choices
	return choices.filter((choice) => {
		const text = `${choice.id} ${choice.label} ${choice.note ?? ''}`.normalize('NFKC').toLowerCase()
		return words.every((word) => text.includes(word))
	})
}
