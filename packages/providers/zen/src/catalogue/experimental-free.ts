import type { ZenModel, ZenService } from '../models.js'

/**
 * Free models with a documented Zen route that operators may try anonymously.
 * This is an experimental request path, separate from verified direct access.
 * Keep the list explicit: a zero price in an injected catalogue cannot admit
 * an arbitrary model or opt a caller into Zen Go.
 */
const EXPERIMENTAL_FREE_ZEN_IDS: ReadonlySet<string> = new Set([
	'big-pickle',
	'ling-3.0-flash-fin-free',
	'longcat-2.5-preview-free',
	'mimo-v2.5-free',
	'mimo-v2.6-flash-free',
	'muse-spark-1.3-contributor-free',
	'nemotron-3-ultra-free',
	'nemotron-3.5-lightning-free',
	'space-bunny-free',
])

export function isExperimentalFreeZenModel(
	service: ZenService,
	model: ZenModel | undefined,
): boolean {
	return (
		service === 'zen' &&
		model !== undefined &&
		EXPERIMENTAL_FREE_ZEN_IDS.has(model.id) &&
		model.inputPrice === 0 &&
		model.outputPrice === 0
	)
}
