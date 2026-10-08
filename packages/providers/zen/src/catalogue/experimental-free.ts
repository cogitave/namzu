import type { ZenModel, ZenService } from '../models.js'

/**
 * Free models: any model with zero input and output price
 * is treated as experimentally available through the anonymous path.
 * No explicit list; the runtime catalogue's price determines availability.
 */
export function isExperimentalFreeZenModel(
	service: ZenService,
	model: ZenModel | undefined,
): boolean {
	return (
		service === 'zen' &&
		model !== undefined &&
		model.inputPrice === 0 &&
		model.outputPrice === 0
	)
}
