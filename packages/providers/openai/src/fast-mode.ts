import { ProviderRequestError } from '@namzu/sdk'
import type { InferenceSpeed, TokenUsage } from '@namzu/sdk'

/**
 * Fast mode on OpenAI models: a premium low-latency tier, asked for with
 * `speed: 'fast'` (or `'ultrafast'` where the route offers it).
 *
 * Two routes, decided differently because the evidence differs:
 *
 * - `api` (an API key, Chat Completions): a table of exact model ids, from the
 *   Fast rows of the vendor's API pricing page and its fast-mode guide
 *   (checked 2026-11-22). A table and not a floor, because OpenAI ids do not
 *   follow one family-and-version grammar. A model absent from the table is
 *   refused until a one-line change, which is cheaper than sending a tier a
 *   model rejects. `ultrafast` is never sent here: Chat Completions has no such
 *   value.
 * - `subscription` (the Codex subscription, Responses): no model list in code.
 *   The account's own model listing says which tiers a model offers
 *   (`ModelInfo.speedTiers`), and a tier is admitted only when it is listed.
 *
 * Everything else is refused here, before transport, so the rule is one rule:
 * `fast` means fast or an error, never a quiet standard-speed reply.
 */

export type OpenAIFastRoute = 'api' | 'subscription'
export type FastTier = 'fast' | 'ultrafast'

export interface OpenAIFastRate {
	/** `billing`: a multiple of the per-token rate. `plan`: the subscription allowance drains faster. */
	readonly kind: 'billing' | 'plan'
	/** Stated by a source for this model; absent when no source states one. Never invented. */
	readonly multiplier?: number
}

export type OpenAIFastVerdict =
	| {
			readonly ok: true
			readonly tier: FastTier
			readonly wire: 'priority' | 'ultrafast'
			readonly rate: OpenAIFastRate
	  }
	| { readonly ok: false; readonly reason: string }

export interface OpenAIFastInput {
	readonly route: OpenAIFastRoute
	readonly model: string
	readonly tier: FastTier
	/** Subscription only: the tiers the account's model listing established for `model`. Absent: not loaded. */
	readonly advertised?: readonly FastTier[]
	/** Whether requests go to OpenAI's own endpoint. Only the `api` route reads it. */
	readonly firstPartyEndpoint: boolean
	/** The host requests go to, named in the refusal when it is not OpenAI's own. */
	readonly host?: string
}

/**
 * Models that take Fast on the API, with the vendor's multiple of every rate.
 * Source: the Fast table of the API pricing page, checked 2026-11-22. The
 * multiple is per model: gpt-5.5 is billed at 2.5 times, the others at 2.
 */
export const OPENAI_FAST_TABLE: Readonly<Record<string, number>> = {
	'gpt-5.4': 2,
	'gpt-5.4-mini': 2,
	'gpt-5.5': 2.5,
	'gpt-5.6-sol': 2,
	'gpt-5.6-terra': 2,
	'gpt-5.6-luna': 2,
	'gpt-6-sol': 2,
	'gpt-6-luna': 2,
	'gpt-6-astra': 2,
	'gpt-6.1-sol': 2,
	'gpt-6.1-terra': 2,
	'gpt-6.2-sol': 2,
	'gpt-6.2-astra': 2,
}

/**
 * How much faster the Codex plan allowance drains on a tier, where a source
 * states it for the model. List-price figures: Ultrafast carries a promotion
 * until 2027-02-28 and these are the figures after it, so a message never
 * understates. Source: the vendor's Codex pricing page, checked 2026-11-22.
 * A model absent here has no stated figure, and the message gives none.
 */
export const PLAN_MULTIPLIER: Readonly<Record<FastTier, Readonly<Record<string, number>>>> = {
	fast: {
		'gpt-6.2-sol': 2,
		'gpt-6.2-astra': 2,
		'gpt-6.1-sol': 2.5,
		'gpt-6.1-terra': 2.5,
		'gpt-6-astra': 2.5,
		'gpt-6-sol': 2.5,
		'gpt-6-luna': 2.5,
	},
	ultrafast: {
		'gpt-6.2-sol': 6,
		'gpt-6.2-astra': 6,
		'gpt-6-astra': 8,
		'gpt-6.1-sol': 8,
	},
}

const SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/

function normalise(model: string): string {
	return model.toLowerCase().replace(SNAPSHOT_SUFFIX, '')
}

/** The model list a refusal names, generated from the table so it is never typed twice. */
function offeredModelsText(): string {
	const ids = Object.keys(OPENAI_FAST_TABLE)
	const named = ids.filter((id) => !id.startsWith('gpt-6'))
	const families = [
		...new Set(ids.filter((id) => id.startsWith('gpt-6')).map((id) => id.replace(/-[a-z]+$/, ''))),
	]
	const familyText =
		families.length > 1
			? `${families.slice(0, -1).join(', ')} and ${families[families.length - 1]}`
			: (families[0] ?? '')
	return `${named.join(', ')}, and the ${familyText} models (sol, terra, luna and astra where they exist)`
}

const refuse = (reason: string): OpenAIFastVerdict => ({ ok: false, reason })

/**
 * Whether `tier` may be sent to `model` on `route`, and what it costs. Pure:
 * the request path and a caller deciding whether to offer the mode use this
 * one function, so they cannot disagree.
 */
export function resolveFastMode(input: OpenAIFastInput): OpenAIFastVerdict {
	const { route, model, tier } = input
	const id = normalise(model)
	if (route === 'api') {
		if (tier === 'ultrafast') {
			return refuse(
				'Ultrafast is offered through the OpenAI (Codex subscription) sign-in only. /fast turns on fast mode here.',
			)
		}
		if (!input.firstPartyEndpoint) {
			return refuse(
				`Fast mode is offered on OpenAI's own endpoint only, and requests here go to ${input.host ?? 'another host'}.`,
			)
		}
		const multiplier = OPENAI_FAST_TABLE[id]
		if (multiplier === undefined) {
			return refuse(
				`Model "${model}" has no fast mode. It is offered on ${offeredModelsText()}; choose one of those with /model.`,
			)
		}
		return {
			ok: true,
			tier: 'fast',
			wire: 'priority',
			rate: { kind: 'billing', multiplier },
		}
	}
	if (input.advertised === undefined) {
		return refuse(
			'Fast mode needs your Codex model list, which has not loaded yet. Try /fast again in a moment.',
		)
	}
	if (!input.advertised.includes(tier)) {
		return refuse(
			tier === 'ultrafast'
				? `Your Codex subscription does not list Ultrafast for model "${model}". It is offered on some plans and models only; /fast turns on fast mode instead.`
				: `Your Codex subscription does not list fast mode for model "${model}". Pick another model with /model.`,
		)
	}
	const multiplier = PLAN_MULTIPLIER[tier][id]
	return {
		ok: true,
		tier,
		wire: tier === 'fast' ? 'priority' : 'ultrafast',
		rate: { kind: 'plan', ...(multiplier !== undefined ? { multiplier } : {}) },
	}
}

/** Whether this model takes `tier` on this route right now. */
export function supportsFastMode(input: OpenAIFastInput): boolean {
	return resolveFastMode(input).ok
}

/**
 * Refuse, before transport, a tier the route would drop or answer with an
 * error. Returns the wire value to send and, on the subscription route, the
 * routing header that goes with it. The error is the `bad_request` the
 * vendor's 400 would have become, with its own code.
 */
export function assertFastModeAccepted(input: OpenAIFastInput): {
	wire: 'priority' | 'ultrafast'
	header?: Record<string, string>
} {
	const verdict = resolveFastMode(input)
	if (!verdict.ok) {
		throw new ProviderRequestError({
			kind: 'bad_request',
			providerId: input.route === 'api' ? 'openai' : 'codex',
			providerCode: 'fast_mode_unsupported',
			detail: verdict.reason,
		})
	}
	return {
		wire: verdict.wire,
		...(input.route === 'subscription'
			? {
					header: {
						'x-codex-routing-hint': `model=${input.model};tier=${verdict.wire}`,
					},
				}
			: {}),
	}
}

/** Whether a base URL is OpenAI's own API host (no URL at all means the default, which is). */
export function isFirstPartyOpenAIEndpoint(baseURL: string | undefined): boolean {
	if (!baseURL) return true
	try {
		return new URL(baseURL).hostname === 'api.openai.com'
	} catch {
		return true
	}
}

/**
 * What a response's `service_tier` says about the call, as the fields
 * `TokenUsage` carries. `priority` and `fast` are Fast and are reported
 * through `speed`, never through `serviceTier` (which the cost rule reads as
 * "unpriced" for `priority`). `default` and `auto` are standard: a request
 * downgraded under load bills at the standard rate. No echo means the tier
 * asked for, so an unreported speed is never priced below what was requested.
 */
export function servedSpeed(
	served: unknown,
	requested: InferenceSpeed | undefined,
): Pick<TokenUsage, 'speed' | 'serviceTier'> {
	if (typeof served === 'string' && served.length > 0) {
		switch (served) {
			case 'priority':
			case 'fast':
				return { speed: 'fast' }
			case 'ultrafast':
				return { speed: 'ultrafast' }
			case 'default':
			case 'auto':
				return {}
			default:
				return { serviceTier: served }
		}
	}
	return requested === 'fast' || requested === 'ultrafast' ? { speed: requested } : {}
}
