import { canSelectModel } from '../integrations/providers/access.js'
import type {
	DetectedProvider,
	ProviderChoice,
	ProviderId,
} from '../integrations/providers/index.js'
import type { ModelListing } from './agent.js'

export interface ModelSwitchRequest {
	readonly model: string
	readonly provider?: string
}

export type ModelSwitchSelection = ProviderChoice & { readonly model: string }

export interface ModelSwitchRejection {
	readonly kind: 'rejected'
	readonly reason: string
	readonly choices?: readonly { readonly provider: ProviderId; readonly model: string }[]
}

export type ModelSwitchResolution =
	| { readonly kind: 'resolved'; readonly selection: ModelSwitchSelection }
	| ModelSwitchRejection

/** Acceptance schedules a change; only the interactive host can commit it. */
export type ModelSwitchOutcome =
	| { readonly kind: 'pending'; readonly selection: ModelSwitchSelection }
	| ModelSwitchRejection

export interface ModelSwitchResolverOptions {
	readonly currentProvider: ProviderId
	readonly detected: readonly DetectedProvider[]
	readonly describeModels: (
		id: ProviderId,
		detected: DetectedProvider,
		signal?: AbortSignal,
	) => Promise<ModelListing>
	readonly signal?: AbortSignal
}

/** Resolve exact catalogue IDs without inferring a provider from the model's name. */
export async function resolveModelSwitch(
	request: ModelSwitchRequest,
	options: ModelSwitchResolverOptions,
): Promise<ModelSwitchResolution> {
	const { signal } = options
	signal?.throwIfAborted()
	const model = request.model.trim()
	const providerId = request.provider?.trim()
	if (!model || model.length > 256 || (providerId !== undefined && !providerId)) {
		return { kind: 'rejected', reason: 'Supply an exact model ID and, optionally, a provider ID.' }
	}
	const seen = new Set<ProviderId>()
	const usable = options.detected.filter((detected) => {
		const { entry } = detected
		if (!entry.constructible || seen.has(entry.id)) return false
		seen.add(entry.id)
		return true
	})
	const selected = providerId ? usable.find(({ entry }) => entry.id === providerId) : undefined
	if (providerId && !selected) {
		return {
			kind: 'rejected',
			reason: `Provider "${providerId}" is unavailable in this session. Available providers: ${usable.map(({ entry }) => entry.id).join(', ') || 'none'}.`,
		}
	}
	if (selected && !canSelectModel(selected.entry, selected.apiKey, model)) {
		return {
			kind: 'rejected',
			reason: `Model "${model}" requires a credential for provider "${selected.entry.id}".`,
		}
	}
	const listed = new Map<ProviderId, ModelListing>()
	const inspect = async (detected: DetectedProvider): Promise<boolean> => {
		signal?.throwIfAborted()
		if (!canSelectModel(detected.entry, detected.apiKey, model)) return false
		let listing: ModelListing
		try {
			listing = await options.describeModels(detected.entry.id, detected, signal)
		} catch {
			signal?.throwIfAborted()
			// Provider failures can contain credentials or private endpoint details.
			listing = { kind: 'failed', reason: 'Model listing failed.' }
		}
		signal?.throwIfAborted()
		listed.set(detected.entry.id, listing)
		return listing.kind === 'ok' && listing.models.some((candidate) => candidate.id === model)
	}
	const resolve = (detected: DetectedProvider): ModelSwitchResolution => ({
		kind: 'resolved',
		selection: { id: detected.entry.id, model },
	})
	const first = selected ?? usable.find(({ entry }) => entry.id === options.currentProvider)
	if (first && (await inspect(first))) return resolve(first)
	const candidates = selected ? [selected] : usable
	const matches = selected
		? []
		: (
				await Promise.all(
					candidates
						.filter((candidate) => candidate !== first)
						.map(async (candidate) => ((await inspect(candidate)) ? candidate : undefined)),
				)
			).filter((candidate): candidate is DetectedProvider => candidate !== undefined)
	signal?.throwIfAborted()
	const uniqueMatch = matches.length === 1 ? matches[0] : undefined
	if (uniqueMatch) return resolve(uniqueMatch)
	if (matches.length > 1) {
		return {
			kind: 'rejected',
			reason: `Model "${model}" is available from multiple providers. Specify one: ${matches.map(({ entry }) => entry.id).join(', ')}.`,
			choices: matches.map(({ entry }) => ({ provider: entry.id, model })),
		}
	}
	const choices = candidates.flatMap((candidate) => {
		const listing = listed.get(candidate.entry.id)
		return listing?.kind === 'ok'
			? listing.models
					.filter((item) => canSelectModel(candidate.entry, candidate.apiKey, item.id))
					.map((item) => ({ provider: candidate.entry.id, model: item.id }))
			: []
	})
	const unverified = candidates
		.filter((candidate) => {
			const listing = listed.get(candidate.entry.id)
			return listing && listing.kind !== 'ok'
		})
		.map(({ entry }) => entry.id)
	// Suggest close catalogue IDs first, before bounding the receipt. A large
	// unrelated provider catalogue must not crowd the requested family out.
	// Ranking is recovery guidance only; partial IDs never select a model.
	const terms = model.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)*/g) ?? []
	const rankedChoices = choices
		.map((choice) => {
			const candidateTerms = new Set(choice.model.toLowerCase().match(/[a-z]+|\d+(?:\.\d+)*/g))
			return { choice, score: terms.filter((term) => candidateTerms.has(term)).length }
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, 8)
		.map(({ choice }) => choice)
	return {
		kind: 'rejected',
		reason: `Model "${model}" was not found in the available model catalogues.${unverified.length > 0 ? ` Could not verify the catalogue for: ${unverified.join(', ')}.` : ''} Use an exact listed model ID.`,
		...(rankedChoices.length > 0 ? { choices: rankedChoices } : {}),
	}
}
