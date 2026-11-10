import type { ChoicePickerOption } from '../../tui/ChoicePicker.js'
import { readStoredApiKey } from '../providers/credential-store.js'

/**
 * OpenRouter as a decision service: the models it lists for decisions, the key Namzu may
 * already hold for it, and the address a connection to it uses. The decision calls speak
 * the same wire as any HTTP decision server, so a connection to it is an `http` block.
 */

export const OPENROUTER_DECISION_URL = 'https://openrouter.ai/api/v1/systemone'
export const OPENROUTER_DECISION_MODELS_URL =
	'https://openrouter.ai/api/v1/models?output_modalities=decisions'
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY'
export const DEFAULT_OPENROUTER_DECISION_MODEL = 'microsoft/microsoft-decision-1'
/** Offered, typed, when the live list cannot be loaded. */
export const FALLBACK_OPENROUTER_DECISION_MODELS = [
	DEFAULT_OPENROUTER_DECISION_MODEL,
	'typesafe/jev-1.14',
] as const
export const OPENROUTER_LIST_TIMEOUT_MS = 3000

export interface OpenRouterDecisionModel {
	readonly id: string
	readonly name: string
	/** USD per million input tokens; undefined when the service gave no price. */
	readonly pricePerMillion?: number
	readonly free: boolean
	readonly contextLength?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The decision models in a `/models?output_modalities=decisions` body, cheapest first (free first), then by name. */
export function parseDecisionModels(body: unknown): OpenRouterDecisionModel[] {
	const data = isRecord(body) ? body.data : undefined
	if (!Array.isArray(data)) return []
	const out: OpenRouterDecisionModel[] = []
	for (const item of data) {
		if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) continue
		const price = isRecord(item.pricing) ? Number(item.pricing.prompt) : Number.NaN
		const hasPrice = Number.isFinite(price) && price >= 0
		const context = Number(item.context_length)
		out.push({
			id: item.id,
			name: typeof item.name === 'string' && item.name ? item.name : item.id,
			...(hasPrice ? { pricePerMillion: price * 1_000_000 } : {}),
			free: hasPrice && price === 0,
			...(Number.isFinite(context) && context > 0 ? { contextLength: context } : {}),
		})
	}
	return out.sort((a, b) => {
		const pa = a.pricePerMillion ?? Number.POSITIVE_INFINITY
		const pb = b.pricePerMillion ?? Number.POSITIVE_INFINITY
		return pa !== pb ? pa - pb : a.name.localeCompare(b.name)
	})
}

export type DecisionModelList =
	| { readonly ok: true; readonly models: readonly OpenRouterDecisionModel[] }
	| { readonly ok: false }

export interface ListDeps {
	readonly fetch?: typeof fetch
	readonly startTimeout?: (ms: number) => {
		readonly signal: AbortSignal
		readonly clear: () => void
	}
}

function realTimeout(ms: number) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), ms)
	return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

/** Fetch the decision models live, with a short deadline. Any failure, or an empty list, is `ok: false`. */
export async function fetchDecisionModels(deps: ListDeps = {}): Promise<DecisionModelList> {
	const timeout = (deps.startTimeout ?? realTimeout)(OPENROUTER_LIST_TIMEOUT_MS)
	try {
		const res = await (deps.fetch ?? globalThis.fetch)(OPENROUTER_DECISION_MODELS_URL, {
			signal: timeout.signal,
		})
		if (!res.ok) return { ok: false }
		const models = parseDecisionModels(await res.json())
		return models.length > 0 ? { ok: true, models } : { ok: false }
	} catch {
		return { ok: false }
	} finally {
		timeout.clear()
	}
}

function trim(value: number): string {
	return String(Number(value.toPrecision(3)))
}

export function formatPrice(model: OpenRouterDecisionModel): string {
	if (model.free) return 'free'
	if (model.pricePerMillion === undefined) return 'price not listed'
	return `$${trim(model.pricePerMillion)} per 1M input tokens`
}

export function formatContext(tokens: number): string {
	return tokens >= 1_000_000
		? `${trim(tokens / 1_000_000)}M context`
		: tokens >= 1000
			? `${Math.round(tokens / 1000)}k context`
			: `${tokens} context`
}

/** The picker rows for the list, and the index of the default model (0 when it is not listed). */
export function decisionModelOptions(models: readonly OpenRouterDecisionModel[]): {
	readonly values: string[]
	readonly options: ChoicePickerOption[]
	readonly defaultIndex: number
} {
	const found = models.findIndex((m) => m.id === DEFAULT_OPENROUTER_DECISION_MODEL)
	return {
		values: models.map((m) => m.id),
		options: models.map((m) => ({
			label: m.name,
			description: [formatPrice(m), m.contextLength ? formatContext(m.contextLength) : undefined]
				.filter(Boolean)
				.join(' · '),
			...(m.id === DEFAULT_OPENROUTER_DECISION_MODEL ? { default: true } : {}),
		})),
		defaultIndex: found >= 0 ? found : 0,
	}
}

export type OpenRouterKey =
	| { readonly source: 'env'; readonly env: string }
	| { readonly source: 'store'; readonly key: string }

/**
 * The OpenRouter key Namzu already has: the environment variable the provider reads, else the
 * key saved for the provider. Absent when there is none, and the flow asks.
 */
export function findOpenRouterKey(
	env: NodeJS.ProcessEnv,
	home?: string,
	readStored: (providerId: string, home?: string) => string | null = readStoredApiKey,
): OpenRouterKey | undefined {
	if (env[OPENROUTER_KEY_ENV]) return { source: 'env', env: OPENROUTER_KEY_ENV }
	try {
		const key = readStored('openrouter', home)
		if (key) return { source: 'store', key }
	} catch {
		// An unreadable store reads as no key; the flow then asks.
	}
	return undefined
}

export function openRouterKeyNotice(found: OpenRouterKey): string {
	return found.source === 'env'
		? `Using your OpenRouter key from ${found.env}.`
		: 'Using the OpenRouter key you already saved.'
}
