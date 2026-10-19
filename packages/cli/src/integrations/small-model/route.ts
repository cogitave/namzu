/**
 * Which model a side job runs on.
 *
 * A side job is a small request the host makes beside the conversation: a
 * short title for it, the answer `web_fetch` extracts from a page. It does not
 * need the conversation's model, and on a large one it would cost more than
 * the work is worth, so it runs on a small one:
 *
 * 1. the model `smallModel` names, as `provider/model` or a bare model id at
 *    the provider the conversation runs on;
 * 2. otherwise the cheapest priced text model the active provider lists, read
 *    from the same listing `/model` offers and priced from that listing or the
 *    in-tree price catalogue;
 * 3. otherwise the conversation's own model.
 *
 * Pure of host state: the listing and the filter are passed in, so every path
 * is testable offline.
 */

import { type ModelInfo, resolveModelPricing } from '@namzu/sdk'

/** A provider and one of its models. */
export interface SideModelTarget {
	readonly providerId: string
	readonly model: string
}

/** Where a route came from, for logs and the docs table. */
export type SideRouteSource = 'configured' | 'cheapest' | 'main'

export interface SideRoute extends SideModelTarget {
	readonly source: SideRouteSource
}

/**
 * Read `smallModel`. `provider/model` names both; a model id that itself holds
 * a slash (`meta-llama/llama-3-8b`) is read as a model of the active provider
 * unless its first segment is a provider the machine knows.
 */
export function parseSmallModel(
	value: string,
	activeProviderId: string,
	isKnownProvider: (id: string) => boolean,
): SideModelTarget {
	const slash = value.indexOf('/')
	if (slash > 0 && slash < value.length - 1) {
		const head = value.slice(0, slash)
		if (isKnownProvider(head)) return { providerId: head, model: value.slice(slash + 1) }
	}
	return { providerId: activeProviderId, model: value }
}

/** Ids that name a model of another kind than chat; a listing has no field for it. */
const NOT_A_CHAT_MODEL = /embed|moderat|whisper|transcri|tts|speech|image|dall-?e|realtime|audio/iu

/** USD per million tokens, input plus output, or `undefined` when nobody states a price. */
function price(providerId: string, model: ModelInfo): number | undefined {
	if (model.inputPrice !== undefined && model.outputPrice !== undefined) {
		return model.inputPrice + model.outputPrice
	}
	const rates = resolveModelPricing(providerId, model.id)
	return rates === undefined ? undefined : rates.inputCostPer1M + rates.outputCostPer1M
}

/**
 * The cheapest text model in a listing, or `undefined` when none states a
 * price. A model with no stated price is never chosen: an unknown price is not
 * a free one, and a side job must not spend money the host cannot read.
 * Ties go to the larger context window, then the shorter id, so the answer is
 * stable across listings.
 */
export function cheapestTextModel(
	providerId: string,
	models: readonly ModelInfo[],
	offerable: (model: ModelInfo) => boolean = () => true,
): ModelInfo | undefined {
	let best: { readonly model: ModelInfo; readonly cost: number } | undefined
	for (const model of models) {
		if (!model.supportsStreaming) continue
		if (model.inputModalities !== undefined && !model.inputModalities.includes('text')) continue
		if (NOT_A_CHAT_MODEL.test(model.id)) continue
		if (!offerable(model)) continue
		const cost = price(providerId, model)
		if (cost === undefined) continue
		if (best === undefined) {
			best = { model, cost }
			continue
		}
		if (cost !== best.cost) {
			if (cost < best.cost) best = { model, cost }
			continue
		}
		const window = model.contextWindow ?? 0
		const bestWindow = best.model.contextWindow ?? 0
		if (window > bestWindow || (window === bestWindow && model.id.length < best.model.id.length)) {
			best = { model, cost }
		}
	}
	return best?.model
}
