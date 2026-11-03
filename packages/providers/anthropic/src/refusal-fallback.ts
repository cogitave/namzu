import { parseVersionedModelId } from '@namzu/sdk'
import { MODEL_ID_GRAMMAR } from './thinking-capability.js'

/**
 * Which family answers when a family declines, in this driver's own words.
 *
 * A refusal comes from a classifier tuned to one model, and another family of
 * the same generation usually serves the same request. The smallest family
 * goes to the middle one, the middle one to the largest, and the largest back
 * to the middle one. A family not listed here has no declared order, so the
 * request stays where it was refused rather than guessing.
 */
const FALLBACK_FAMILY: Readonly<Record<string, string>> = {
	haiku: 'sonnet',
	sonnet: 'opus',
	opus: 'sonnet',
}

/**
 * The listed model that answers for `model` after it declined, or `undefined`.
 *
 * Only a model the credential can actually serve is returned: `listed` is the
 * service's own model list, so a family or generation this account cannot reach
 * is never named. The same generation is required (major and minor), because a
 * different generation is a different model with different behaviour, not a
 * second opinion. Of several ids for one generation (a dated release beside its
 * alias) the shortest is taken, which is the alias.
 */
export function refusalFallbackFromList(
	model: string,
	listed: readonly string[],
): string | undefined {
	const parsed = parseVersionedModelId(model, MODEL_ID_GRAMMAR)
	if (!parsed) return undefined
	const family = FALLBACK_FAMILY[parsed.family]
	if (!family) return undefined
	const matches = listed.filter((id) => {
		const candidate = parseVersionedModelId(id, MODEL_ID_GRAMMAR)
		return (
			candidate !== undefined &&
			candidate.family === family &&
			candidate.major === parsed.major &&
			candidate.minor === parsed.minor
		)
	})
	return [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
}
