import type { LLMProvider, ModelInfo, ReasoningEffort } from '@namzu/sdk'

const levels = new Set<ReasoningEffort>([
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
])

/** A capability-only view: catalogue metadata is scoped to this exact provider/model. */
export function modelReasoningView(
	provider: LLMProvider,
	model: string,
	catalogue: readonly ModelInfo[],
): LLMProvider {
	const rows = catalogue.filter((item) => item.id === model)
	const entry = rows.length === 1 ? rows[0] : undefined
	const published = entry?.reasoningEffortLevels
	const valid =
		Array.isArray(published) &&
		published.every((level) => levels.has(level)) &&
		new Set(published).size === published.length
	const menu = valid
		? Object.freeze([...published])
		: published !== undefined || rows.length > 1
			? undefined
			: provider.reasoningEffortLevelsFor
				? provider.reasoningEffortLevelsFor(model)
				: provider.effortLevelsFor?.(model)
	let candidateDefault = entry?.reasoningEffortDefault
	if (candidateDefault === undefined) {
		try {
			candidateDefault = provider.reasoningEffortDefaultFor?.(model)
		} catch {
			// An unavailable default must not erase an established menu.
		}
	}
	// Preserve the declaration so the host can diagnose a default outside its menu.
	const defaultEffort =
		candidateDefault !== undefined && levels.has(candidateDefault) ? candidateDefault : undefined
	return {
		id: provider.id,
		name: provider.name,
		capabilities: provider.capabilities,
		...(provider.supportsHostedWebSearchFor
			? {
					supportsHostedWebSearchFor: provider.supportsHostedWebSearchFor.bind(provider),
				}
			: {}),
		chatStream: (params) => provider.chatStream(params),
		reasoningEffortLevelsFor: (requested) => (requested === model ? menu : undefined),
		reasoningEffortDefaultFor: (requested) => (requested === model ? defaultEffort : undefined),
	}
}
