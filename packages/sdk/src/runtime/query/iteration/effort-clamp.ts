import type { LLMProvider, ReasoningEffort, ThinkingConfig } from '../../../types/provider/index.js'

/** Lowest to highest, the order the effort menus are drawn in. */
const EFFORT_ORDER: readonly ReasoningEffort[] = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
]

/**
 * The effort to send to `model` when the turn was configured for another one.
 *
 * A level the model does not offer is rejected by some drivers, so a request
 * moved to a different model (a refusal fallback, a live model pick) carries
 * the nearest level that model supports: the next one down when there is one,
 * otherwise the lowest one above. The menu comes from the provider, never from
 * a copy here. A provider that cannot say what the model offers, or a level
 * the model already offers, leaves the effort exactly as configured.
 */
export function effortForModel(
	provider: LLMProvider,
	model: string,
	effort: ReasoningEffort,
	thinking?: ThinkingConfig,
): ReasoningEffort {
	let menu: readonly ReasoningEffort[] | undefined
	try {
		menu = provider.reasoningEffortLevelsFor
			? provider.reasoningEffortLevelsFor(model, thinking)
			: provider.effortLevelsFor?.(model, thinking)
	} catch {
		return effort
	}
	if (!menu || menu.length === 0 || menu.includes(effort)) return effort
	const rank = (level: ReasoningEffort) => EFFORT_ORDER.indexOf(level)
	const wanted = rank(effort)
	if (wanted < 0) return effort
	const ranked = menu.filter((level) => rank(level) >= 0).sort((a, b) => rank(a) - rank(b))
	const below = ranked.filter((level) => rank(level) < wanted)
	return below[below.length - 1] ?? ranked[0] ?? effort
}
