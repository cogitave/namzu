/**
 * Settings for the built-in learning generator. It is on unless the person
 * turns it off, and what it may spend is bounded twice: one cycle, and one day.
 */

/** Tokens one cycle may record before it stops. A full cycle is about 60 model calls. */
export const DEFAULT_CYCLE_TOKENS = 120_000
/** Tokens all cycles together may record in one local calendar day. */
export const DEFAULT_DAILY_TOKENS = 300_000
/** New observations needed before a cycle starts by itself. */
export const MIN_OBSERVATIONS = 5
/** The pause between two automatic cycles, whatever their outcome. */
export const COOLDOWN_MS = 6 * 60 * 60 * 1000

export interface LearningGeneratorSettings {
	readonly enabled: boolean
	readonly cycleTokens: number
	readonly dailyTokens: number
}

/** The shape of the `learningGenerator` config key: a switch, or a mapping. */
export type LearningGeneratorConfig =
	| boolean
	| {
			readonly enabled?: boolean
			readonly cycleTokens?: number
			readonly dailyTokens?: number
	  }

export function resolveGeneratorSettings(
	config: LearningGeneratorConfig | undefined,
): LearningGeneratorSettings {
	if (typeof config === 'boolean')
		return { enabled: config, cycleTokens: DEFAULT_CYCLE_TOKENS, dailyTokens: DEFAULT_DAILY_TOKENS }
	return {
		enabled: config?.enabled !== false,
		cycleTokens: config?.cycleTokens ?? DEFAULT_CYCLE_TOKENS,
		dailyTokens: config?.dailyTokens ?? DEFAULT_DAILY_TOKENS,
	}
}
