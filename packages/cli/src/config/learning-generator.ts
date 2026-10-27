import {
	DEFAULT_CYCLE_TOKENS,
	DEFAULT_DAILY_TOKENS,
	type LearningGeneratorConfig,
	resolveGeneratorSettings,
} from '../integrations/learning/generator-settings.js'

/** The most a person may allow in one setting; anything above is a typo. */
export const MAX_LEARNING_TOKENS = 10_000_000
export const MIN_LEARNING_TOKENS = 1_000

/**
 * Merge two layers of `learningGenerator`. A user or managed layer replaces
 * what is below it. A project layer is repository content and can only make
 * learning smaller: it can turn it off and lower a cap, never turn it back on
 * or spend more than the person already allowed.
 */
export function mergeLearningGenerator(
	previous: LearningGeneratorConfig | undefined,
	next: LearningGeneratorConfig,
	fromProject: boolean,
): LearningGeneratorConfig {
	if (!fromProject) return next
	const before = resolveGeneratorSettings(previous)
	const after = resolveGeneratorSettings(next)
	return {
		enabled: before.enabled && after.enabled,
		cycleTokens: Math.min(before.cycleTokens, after.cycleTokens),
		dailyTokens: Math.min(before.dailyTokens, after.dailyTokens),
	}
}

export { DEFAULT_CYCLE_TOKENS, DEFAULT_DAILY_TOKENS }
