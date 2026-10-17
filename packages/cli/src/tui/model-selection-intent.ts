import { canSelectModel } from '../integrations/providers/access.js'
import type { ModelSwitchResolution, ModelSwitchResolverOptions } from './model-switch.js'

const ID = '([a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255})'
const patterns = [
	/^([a-z0-9][a-z0-9._:/ -]{0,255}(?:['’](?:ya|ye|a|e))?)\s+(?:geç|gec|geçer misin|gecer misin|geçebilir misin|gecebilir misin)[.!?]?$/i,
	new RegExp(`^/model\\s+${ID}$`, 'i'),
	new RegExp(
		`^(?:please\\s+)?(?:switch|change|set)\\s+(?:the\\s+)?model\\s+to\\s+${ID}(?:\\s+please)?[.!?]?$`,
		'i',
	),
	new RegExp(
		`^(?:can|could)\\s+you\\s+(?:switch|change|set)\\s+(?:the\\s+)?model\\s+to\\s+${ID}(?:\\s+please)?[.!?]?$`,
		'i',
	),
	new RegExp(
		`^(?:lütfen\\s+)?modeli\\s+${ID}\\s+(?:yap|yapar mısın|yapar misin|yapabilir misin|olarak değiştir|olarak degistir)[.!?]?$`,
		'i',
	),
]

/** Only standalone operator selection requests; prose about other work stays model input. */
export function parseModelSelectionIntent(text: string): { query: string } | undefined {
	const trimmed = text.trim()
	if (trimmed.includes('\n')) return undefined
	for (const pattern of patterns) {
		const query = pattern.exec(trimmed)?.[1]
		if (query) return { query }
	}
	return undefined
}

const normalized = (id: string) =>
	id
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, '-')

/** Exact IDs first, then a unique complete suffix; never infer a model family or effort. */
export async function resolveModelSelectionIntent(
	query: string,
	options: ModelSwitchResolverOptions,
): Promise<ModelSwitchResolution> {
	const selectedProvider = options.detected.find(({ entry }) =>
		query.toLowerCase().startsWith(`${entry.id}/`),
	)?.entry.id
	const modelQuery = selectedProvider ? query.slice(selectedProvider.length + 1) : query
	const candidates: Array<{
		provider: ModelSwitchResolverOptions['currentProvider']
		model: string
	}> = []
	let unavailable = false
	const seen = new Set<string>()
	await Promise.all(
		options.detected.map(async (detected) => {
			if (
				!detected.entry.constructible ||
				seen.has(detected.entry.id) ||
				(selectedProvider && detected.entry.id !== selectedProvider)
			)
				return
			seen.add(detected.entry.id)
			options.signal?.throwIfAborted()
			try {
				const listing = await options.describeModels(detected.entry.id, detected, options.signal)
				if (listing.kind !== 'ok') {
					unavailable = true
					return
				}
				for (const item of listing.models) {
					if (canSelectModel(detected.entry, detected.apiKey, item.id))
						candidates.push({ provider: detected.entry.id, model: item.id })
				}
			} catch {
				options.signal?.throwIfAborted()
				unavailable = true
			}
		}),
	)
	options.signal?.throwIfAborted()
	const needle = normalized(modelQuery)
	let exact = candidates.filter((item) => normalized(item.model) === needle)
	let matches =
		exact.length > 0
			? exact
			: candidates.filter(
					(item) => /\d/.test(needle) && normalized(item.model).endsWith(`-${needle}`),
				)
	// Turkish dative endings are a fallback, never edits to an already listed ID.
	if (matches.length === 0) {
		const stems = new Set<string>()
		for (const ending of ['ya', 'ye', 'a', 'e']) {
			if (needle.endsWith(ending)) stems.add(needle.slice(0, -ending.length).replace(/['’]$/, ''))
		}
		exact = candidates.filter((item) => stems.has(normalized(item.model)))
		matches =
			exact.length > 0
				? exact
				: candidates.filter((item) =>
						[...stems].some(
							(stem) => /\d/.test(stem) && normalized(item.model).endsWith(`-${stem}`),
						),
					)
	}
	const currentExact = exact.filter((item) => item.provider === options.currentProvider)
	if (currentExact.length === 1) matches = currentExact
	const unique = [
		...new Map(matches.map((item) => [`${item.provider}:${item.model}`, item])).values(),
	]
	if (unique.length === 1 && (!unavailable || exact.length > 0)) {
		const match = unique[0]
		if (match) return { kind: 'resolved', selection: { id: match.provider, model: match.model } }
	}
	return {
		kind: 'rejected',
		reason:
			unique.length > 1
				? `"${query}" matches more than one model, so nothing changed. Use /model to pick one.`
				: unavailable
					? `Couldn’t check "${query}" against the model lists right now, so the model was not changed. Use /model to pick one.`
					: `No model called "${query}" is available to you, so the model was not changed. Use /model to see what is.`,
		...(unique.length > 0 ? { choices: unique.slice(0, 8) } : {}),
	}
}

/**
 * Whether a captured model query asks for Auto rather than a model called
 * "auto". Auto is a reserved choice, never a model id, so it is recognised
 * before any model list is consulted: the lookup would otherwise answer
 * "No model called auto".
 */
export function isAutoQuery(query: string): boolean {
	return /^(?:auto|otomatik)(?:['’]?(?:ya|ye|a|e))?$/i.test(query.trim())
}

export const AUTO_ALREADY_ON = 'Auto is already on. Namzu picks a model for each task.'

export const AUTO_ON_NOTICE =
	'Auto is on for this launch: Namzu picks a model for each task. To make it the default every time, set model: auto in your config (see docs/cli/auto-model-routing.md).'

export const AUTO_TURNED_OFF_SUFFIX = ' Auto is off; choose Auto in /model to turn it back on.'

/**
 * Why Auto cannot be chosen right now, in plain words, or `undefined` when it
 * can. Auto needs a `routing` block in the user config to know which models it
 * may pick from, and a Pal keeps the model it was set up with.
 */
export function autoRefusal(routingConfigured: boolean, inPal: boolean): string | undefined {
	if (inPal) return 'Auto is not available in a Pal conversation. A Pal keeps its own model.'
	if (!routingConfigured) {
		return 'Auto is not set up. It needs a routing block in your user config (~/.namzu/config.yaml) that says which models to pick from. See docs/cli/auto-model-routing.md.'
	}
	return undefined
}

export const AUTO_MODEL_LABEL = 'Auto'

/**
 * The model name the status line shows while Auto is on: `Auto` until a turn
 * has been routed, then the tier and model that turn went to.
 */
export function autoModelLabel(
	route: { readonly tier: string; readonly model: string } | undefined,
): string {
	return route ? `${AUTO_MODEL_LABEL} · ${route.tier} · ${route.model}` : AUTO_MODEL_LABEL
}
