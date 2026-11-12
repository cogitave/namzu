/**
 * The spend report: what the ledger holds, cut by local day, model, project
 * and kind of work for the last N days.
 *
 * Honesty rules, all of which come from the record and the rate catalogue:
 *
 * - A price is the one the kernel stamped on the call when it was made, from
 *   the catalogue. Nothing here prices a token again or invents a rate.
 * - Tokens with no known price are counted (`unpricedTokens`) and never turned
 *   into money. A cell whose price is partly or wholly missing says so.
 * - Money is a total at list prices: an estimate, never a bill.
 * - A route the catalogue marks as billing nothing per token (a local server)
 *   is said to be such. A subscription or a free quota is not something the
 *   record knows, so it is not claimed.
 */

import { VENDOR_RATES } from '@namzu/sdk'

import {
	DEFAULT_SPEND_DAYS,
	MAX_SPEND_DAYS,
	SLOT_MS,
	type SpendClock,
	createDayKeyer,
	shiftDay,
} from './day.js'
import type { SpendRow } from './fold.js'
import type { Ledger, LedgerSession } from './ledger.js'

export const SPEND_REPORT_SCHEMA_VERSION = 1
/** Conversations listed in the report, largest first. */
export const TOP_CONVERSATIONS = 10

export interface SpendTotals {
	/** Every token the calls used, as the driver counted them. */
	tokens: number
	/** Prompt tokens that were not read from the cache. */
	freshInputTokens: number
	/** Prompt tokens whose cache share the record does not separate; not in `freshInputTokens`. */
	unsplitInputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	outputTokens: number
	/** Estimated cost in US dollars of the tokens that have a known price. */
	estimatedCostUsd: number
	/** Tokens with no known price: not in `estimatedCostUsd`, and not free. */
	unpricedTokens: number
}

export type SpendKindName = 'replies' | 'subagents' | 'compaction' | 'internal'

export interface ModelSpend extends SpendTotals {
	/** The route the record names, or null. */
	provider: string | null
	model: string
	/** `local` when the catalogue says the route bills nothing per token; `per-token` otherwise. */
	billing: 'per-token' | 'local'
	/** Whether every token of this model has a known price. */
	priceKnown: boolean
}

export interface DaySpend extends SpendTotals {
	date: string
	models: ModelSpend[]
}

export interface ProjectSpend extends SpendTotals {
	slug: string
	/** The folder the project was opened in, when a log said so. */
	path: string | null
}

export interface KindSpend extends SpendTotals {
	kind: SpendKindName
}

export interface ConversationSpend extends SpendTotals {
	id: string
	slug: string
	/** Set for a sub-agent's log: what kind of child it is. */
	subagent: string | null
}

export interface SpendReport {
	schemaVersion: typeof SPEND_REPORT_SCHEMA_VERSION
	kind: 'spend'
	/** Always true: money is estimated from list prices. */
	estimate: true
	currency: 'USD'
	window: { days: number; from: string; to: string; timeZone: string }
	totals: SpendTotals & {
		/** True when some tokens have no known price, so `estimatedCostUsd` is a floor. */
		partial: boolean
		/** The models those tokens ran on. */
		unpricedModels: string[]
		conversations: number
	}
	days: DaySpend[]
	models: ModelSpend[]
	projects: ProjectSpend[]
	kinds: KindSpend[]
	/** The largest conversations in the window, by estimated cost then tokens. */
	topConversations: ConversationSpend[]
	/** Facts the record does not hold, so a reader does not mistake a gap for a zero. */
	notes: string[]
}

const emptyTotals = (): SpendTotals => ({
	tokens: 0,
	freshInputTokens: 0,
	unsplitInputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 0,
	estimatedCostUsd: 0,
	unpricedTokens: 0,
})

function addRow(into: SpendTotals, row: SpendRow): void {
	into.tokens += row[3]
	into.freshInputTokens += row[4]
	into.unsplitInputTokens += row[5]
	into.cacheReadTokens += row[6]
	into.cacheWriteTokens += row[7]
	into.outputTokens += row[8]
	into.estimatedCostUsd += row[9]
	into.unpricedTokens += row[10]
}

const UNMETERED = new Set(VENDOR_RATES.filter((v) => v.unmetered).map((v) => v.providerId))

function billingOf(provider: string | null): 'per-token' | 'local' {
	return provider !== null && UNMETERED.has(provider) ? 'local' : 'per-token'
}

/** The conversation id a ledger key spells: the log's file name without its extension. */
export function conversationId(key: string): string {
	const name = key.slice(key.lastIndexOf('/') + 1)
	return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name
}

/** Every row of one conversation, settled and open. */
export function rowsOf(session: LedgerSession): readonly SpendRow[] {
	return session.open.length === 0 ? session.rows : [...session.rows, ...session.open]
}

/**
 * What one conversation cost, over its whole life: the figure a person reads
 * for that conversation. The report's total is the sum of these for the
 * conversations it covers, which is what the reconciliation test asserts.
 */
export function conversationTotals(session: LedgerSession): SpendTotals {
	const totals = emptyTotals()
	for (const row of rowsOf(session)) addRow(totals, row)
	return totals
}

export interface SpendQuery {
	readonly ledger: Ledger
	readonly clock: SpendClock
	/** Local days to cover, today included. */
	readonly days?: number
}

function kindOf(session: LedgerSession, row: SpendRow): SpendKindName {
	if (session.parentKind !== undefined) return 'subagents'
	return row[1] === 1 ? 'compaction' : row[1] === 2 ? 'internal' : 'replies'
}

/** The totals kept under `key`, made when the first row for it arrives. */
function slot<K>(map: Map<K, SpendTotals>, key: K): SpendTotals {
	let totals = map.get(key)
	if (totals === undefined) {
		totals = emptyTotals()
		map.set(key, totals)
	}
	return totals
}

export function buildSpendReport(query: SpendQuery): SpendReport {
	const days = Math.max(1, Math.min(MAX_SPEND_DAYS, Math.floor(query.days ?? DEFAULT_SPEND_DAYS)))
	const { ledger, clock } = query
	const keyer = createDayKeyer(clock.timeZone)
	const today = keyer(clock.nowMs())
	const from = shiftDay(today, days - 1)

	const total = emptyTotals()
	const byDay = new Map<string, { totals: SpendTotals; models: Map<number, SpendTotals> }>()
	const byModel = new Map<number, SpendTotals>()
	const byProject = new Map<string, SpendTotals>()
	const byKind = new Map<SpendKindName, SpendTotals>()
	const conversations: ConversationSpend[] = []
	const unpricedModelIds = new Set<number>()
	let engineConversations = 0
	let unsplit = 0
	let ahead = 0

	for (const [key, session] of ledger.sessions) {
		const mine = emptyTotals()
		let touched = false
		for (const row of rowsOf(session)) {
			const day = keyer(row[0] * SLOT_MS)
			if (day < from) continue
			touched = true
			if (day > today) ahead += row[3]
			addRow(total, row)
			addRow(mine, row)
			let dayEntry = byDay.get(day)
			if (dayEntry === undefined) {
				dayEntry = { totals: emptyTotals(), models: new Map() }
				byDay.set(day, dayEntry)
			}
			addRow(dayEntry.totals, row)
			addRow(slot(dayEntry.models, row[2]), row)
			addRow(slot(byModel, row[2]), row)
			addRow(slot(byProject, session.slug), row)
			addRow(slot(byKind, kindOf(session, row)), row)
			if (row[10] > 0) unpricedModelIds.add(row[2])
			unsplit += row[5]
		}
		if (!touched) continue
		if (session.engineId !== undefined) engineConversations += 1
		conversations.push({
			id: conversationId(key),
			slug: session.slug,
			subagent: session.parentKind ?? null,
			...mine,
		})
	}

	const modelRow = (id: number, totals: SpendTotals): ModelSpend => {
		const key = ledger.models.list[id] as { provider: string | null; model: string }
		return {
			provider: key.provider,
			model: key.model,
			billing: billingOf(key.provider),
			priceKnown: totals.unpricedTokens === 0,
			...totals,
		}
	}
	// Ties end on a name, so the same logs give the same report whatever order they were read in.
	const byCostThenTokens = <T extends SpendTotals>(a: T, b: T, name: (row: T) => string) =>
		b.estimatedCostUsd - a.estimatedCostUsd ||
		b.tokens - a.tokens ||
		(name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0)
	const modelName = (row: ModelSpend) => `${row.provider ?? ''}\u0000${row.model}`

	const dayRows: DaySpend[] = [...byDay.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([date, entry]) => ({
			date,
			...entry.totals,
			models: [...entry.models.entries()]
				.map(([id, totals]) => modelRow(id, totals))
				.sort((a, b) => byCostThenTokens(a, b, modelName)),
		}))
	const models = [...byModel.entries()]
		.map(([id, totals]) => modelRow(id, totals))
		.sort((a, b) => byCostThenTokens(a, b, modelName))
	const projects: ProjectSpend[] = [...byProject.entries()]
		.map(([slug, totals]) => ({ slug, path: ledger.projects.get(slug) ?? null, ...totals }))
		.sort((a, b) => byCostThenTokens(a, b, (row) => row.slug))
	const kindOrder: SpendKindName[] = ['replies', 'subagents', 'compaction', 'internal']
	const kinds: KindSpend[] = kindOrder
		.filter((kind) => byKind.has(kind))
		.map((kind) => ({ kind, ...(byKind.get(kind) as SpendTotals) }))

	const unpricedModels = [...unpricedModelIds].map((id) => {
		const key = ledger.models.list[id] as { provider: string | null; model: string }
		return key.provider === null ? key.model : `${key.model} (${key.provider})`
	})
	const notes: string[] = []
	if (unsplit > 0) {
		notes.push(
			`${unsplit.toLocaleString('en-US')} input tokens ran on a route whose rate card is not in the catalogue, so the record cannot say how many of them were read from the cache. They are listed as unsplit input.`,
		)
	}
	if (ahead > 0) {
		notes.push(
			`${ahead.toLocaleString('en-US')} tokens are recorded on days after today by this machine's clock (a log written ahead of it). They are included.`,
		)
	}
	if (engineConversations > 0) {
		notes.push(
			`${engineConversations} conversation${engineConversations === 1 ? '' : 's'} ran through an outside engine. The record does not say how that engine bills, so its tokens count and its price is shown only where one is known.`,
		)
	}
	notes.push(
		'The record marks compaction passes and the replies of sub-agents, so those are shown apart. It does not mark other internal calls: one made between two replies is counted with the next reply, and only what the turn settled beyond its last reply is shown as internal.',
		'Which subscription or free quota paid for a call is not recorded, so none is claimed. A route is called local only when the catalogue says it bills nothing per token.',
	)

	return {
		schemaVersion: SPEND_REPORT_SCHEMA_VERSION,
		kind: 'spend',
		estimate: true,
		currency: 'USD',
		window: { days, from, to: today, timeZone: clock.timeZone },
		totals: {
			...total,
			partial: total.unpricedTokens > 0,
			unpricedModels,
			conversations: conversations.length,
		},
		days: dayRows,
		models,
		projects,
		kinds,
		topConversations: conversations
			.sort((a, b) => byCostThenTokens(a, b, (row) => row.id))
			.slice(0, TOP_CONVERSATIONS),
		notes,
	}
}
