/**
 * Fold one session log into spend rows.
 *
 * What the log holds, and what this reads of it:
 *
 * - `token_usage_updated`: the TURN'S cumulative usage and cost after each
 *   model call (and after a compaction pass). The difference between two of
 *   them is what the calls in between cost, priced by the kernel when it was
 *   recorded. Nothing is priced again here.
 * - `turn_completed` / `turn_failed`: the settled total of the turn.
 * - `turn_started.config.model`, `request_envelope.model` and
 *   `provider_fallback`: which model was asked and, after a fallback, which
 *   route took over.
 * - `session_started`: the parent (a sub-agent log) and the outside engine.
 *
 * The differences telescope: the rows of a settled turn add up to its
 * settlement, and those of an open turn to its last cumulative figure. That
 * is what the per-conversation total is, so a total made from rows and a
 * total made from turns cannot disagree.
 *
 * Every turn's running figure starts from zero. A new turn, whether it is the
 * second in the same process, the first after the conversation was continued
 * in another process, or the first of a fork, opens its own recorder; only a
 * turn resumed after a pause (`turn_resuming`, same turn id, no new
 * `turn_started`) restores figures, and those are that same turn's own earlier
 * figures, which the open turn here already holds. So the figures are never
 * compared with an earlier turn's: a comparison of magnitudes would mistake a
 * turn that happens to use more than everything before it for a running total.
 *
 * Kinds of work are read from the record, not guessed. A difference that ends
 * at a compaction pass's snapshot (`contextMeasuredBy: 'estimate'`) is
 * compaction. A difference that ends at a model reply is a reply, and holds
 * any internal call made since the previous reply, because the record does
 * not mark those apart. What the settlement holds beyond the last snapshot
 * is `internal`.
 */

import { resolveModelPricing } from '@namzu/sdk'

import { slotOf } from './day.js'

export const KIND_REPLY = 0
export const KIND_COMPACTION = 1
export const KIND_INTERNAL = 2
export type SpendKind = typeof KIND_REPLY | typeof KIND_COMPACTION | typeof KIND_INTERNAL

/** A route and a model, as the record names them. The route is `null` when the record never says. */
export interface ModelKey {
	readonly provider: string | null
	readonly model: string
}

/** Cumulative figures of one turn, as the record holds them. */
export interface Cumulative {
	prompt: number
	completion: number
	total: number
	cacheRead: number
	cacheWrite: number
	cost: number
	unpriced: number
}

export const ZERO: Cumulative = {
	prompt: 0,
	completion: 0,
	total: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	unpriced: 0,
}

/** One difference between two cumulative figures, with where and when it landed. */
interface Delta extends Cumulative {
	readonly slot: number
	readonly kind: SpendKind
	readonly model: string
	/** `undefined` until the turn settles and says who served it. */
	provider: string | null | undefined
}

/**
 * A row of the ledger: spend in one 15-minute slot of one kind on one model.
 * Positions are fixed because a ledger of tens of thousands of conversations
 * is mostly these.
 */
export type SpendRow = readonly [
	slot: number,
	kind: SpendKind,
	model: number,
	tokens: number,
	freshInput: number,
	/** Prompt tokens whose fresh share could not be told from the cache reads. */
	freshUnknown: number,
	cacheRead: number,
	cacheWrite: number,
	output: number,
	costUsd: number,
	unpricedTokens: number,
]

/** The model table shared by every row of a ledger. */
export class ModelTable {
	readonly list: ModelKey[] = []
	readonly #index = new Map<string, number>()

	constructor(initial: readonly ModelKey[] = []) {
		for (const key of initial) this.indexOf(key)
	}

	indexOf(key: ModelKey): number {
		const id = `${key.provider ?? ''}\u0000${key.model}`
		const hit = this.#index.get(id)
		if (hit !== undefined) return hit
		this.list.push(key)
		this.#index.set(id, this.list.length - 1)
		return this.list.length - 1
	}
}

export interface SessionFacts {
	/** `agent_spawn`, `user_handoff` or `intervention` for a sub-agent log. */
	parentKind?: string
	cwd?: string
	engineId?: string
}

/** What folding a stretch of one log produced. */
export interface FoldResult {
	/** Rows of turns that settled inside the stretch. */
	readonly settled: SpendRow[]
	/** Rows of a turn still open at the end of the stretch, to be recomputed next time. */
	readonly open: SpendRow[]
	/** Where the next stretch starts: the open turn's first line, or the end of the last complete line. */
	readonly from: number
	readonly facts: SessionFacts
}

const INTERESTING =
	/"type":"(?:session_started|turn_started|request_envelope|provider_fallback|token_usage_updated|turn_completed|turn_failed)"/

const num = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0

export function cumulativeOf(usage: unknown, cost: unknown): Cumulative {
	const u = (usage ?? {}) as Record<string, unknown>
	const c = (cost ?? {}) as Record<string, unknown>
	return {
		prompt: num(u.promptTokens),
		completion: num(u.completionTokens),
		total: num(u.totalTokens),
		cacheRead: num(u.cachedTokens),
		cacheWrite: num(u.cacheWriteTokens),
		cost: num(c.totalCost),
		unpriced: num(c.unpricedTokens),
	}
}

function minus(a: Cumulative, b: Cumulative): Cumulative {
	return {
		prompt: a.prompt - b.prompt,
		completion: a.completion - b.completion,
		total: a.total - b.total,
		cacheRead: a.cacheRead - b.cacheRead,
		cacheWrite: a.cacheWrite - b.cacheWrite,
		cost: a.cost - b.cost,
		unpriced: a.unpriced - b.unpriced,
	}
}

function isZero(d: Cumulative): boolean {
	return (
		d.prompt === 0 &&
		d.completion === 0 &&
		d.total === 0 &&
		d.cacheRead === 0 &&
		d.cacheWrite === 0 &&
		d.cost === 0 &&
		d.unpriced === 0
	)
}

/**
 * The share of a prompt that was not read from the cache. Drivers disagree on
 * whether the prompt count already holds the cache reads, and that is a fact
 * of the route's rate card; where no card names the route the share is not
 * known, unless nothing was read from the cache and there is nothing to
 * separate.
 */
function freshShare(delta: Delta, provider: string | null): { fresh: number; unknown: number } {
	if (delta.cacheRead === 0) return { fresh: delta.prompt, unknown: 0 }
	const card = provider === null ? undefined : resolveModelPricing(provider, delta.model)
	if (card?.cache === undefined) return { fresh: 0, unknown: delta.prompt }
	return {
		fresh: card.cache.promptIncludesCacheReads
			? Math.max(0, delta.prompt - delta.cacheRead)
			: delta.prompt,
		unknown: 0,
	}
}

/** Add rows into a slot-kind-model keyed map, summing the figures. */
export class RowSink {
	readonly #rows = new Map<string, number[]>()

	constructor(private readonly models: ModelTable) {}

	add(delta: Delta, provider: string | null): void {
		const share = freshShare(delta, provider)
		const model = this.models.indexOf({ provider, model: delta.model })
		const key = `${delta.slot}:${delta.kind}:${model}`
		let row = this.#rows.get(key)
		if (row === undefined) {
			row = [delta.slot, delta.kind, model, 0, 0, 0, 0, 0, 0, 0, 0]
			this.#rows.set(key, row)
		}
		row[3] = (row[3] as number) + delta.total
		row[4] = (row[4] as number) + share.fresh
		row[5] = (row[5] as number) + share.unknown
		row[6] = (row[6] as number) + delta.cacheRead
		row[7] = (row[7] as number) + delta.cacheWrite
		row[8] = (row[8] as number) + delta.completion
		row[9] = (row[9] as number) + delta.cost
		row[10] = (row[10] as number) + delta.unpriced
	}

	rows(): SpendRow[] {
		return [...this.#rows.values()] as unknown as SpendRow[]
	}
}

interface OpenTurn {
	readonly startOffset: number
	readonly deltas: Delta[]
	/** The turn's latest running figure; each difference is measured from it. */
	previous: Cumulative
	model: string
	provider: string | null | undefined
	earlyProvider: string | undefined
	fellBack: boolean
	lastTs: number
}

function parseTs(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined
	const ms = Date.parse(value)
	return Number.isFinite(ms) ? ms : undefined
}

/**
 * Folds a log fed to it in pieces, so a log of any size is read in bounded
 * memory. It starts at a turn boundary (the start of the file, or where a
 * previous fold said to resume). A trailing line without its newline is a
 * write in progress and is left for the next fold.
 */
export class LogFolder {
	readonly #settledSink: RowSink
	readonly #openSink: RowSink
	readonly #facts: SessionFacts = {}
	#turn: OpenTurn | undefined
	#lastSettled: Cumulative | undefined
	/** Bytes of a line that has not ended yet, and where it starts. */
	#tail: Buffer = Buffer.alloc(0)
	#tailOffset: number

	constructor(
		private readonly models: ModelTable,
		baseOffset: number,
	) {
		this.#settledSink = new RowSink(models)
		this.#openSink = new RowSink(models)
		this.#tailOffset = baseOffset
	}

	/** What the most recent turn that settled came to, as its settlement states it. */
	get lastSettled(): Cumulative | undefined {
		return this.#lastSettled
	}

	feed(chunk: Buffer): void {
		const buffer = this.#tail.length === 0 ? chunk : Buffer.concat([this.#tail, chunk])
		let position = 0
		while (position < buffer.length) {
			const newline = buffer.indexOf(10, position)
			if (newline === -1) break
			this.#line(buffer.toString('utf8', position, newline), this.#tailOffset + position)
			position = newline + 1
		}
		this.#tail = Buffer.from(buffer.subarray(position))
		this.#tailOffset += position
	}

	#settle(settlement: Record<string, unknown> | undefined, ts: number): void {
		const current = this.#turn
		if (current === undefined) return
		this.#turn = undefined
		let end: Cumulative | undefined
		if (settlement !== undefined) {
			end = cumulativeOf(settlement.usage, settlement.cost)
			this.#lastSettled = end
			const tail = minus(end, current.previous)
			if (!isZero(tail)) {
				current.deltas.push({
					...tail,
					slot: slotOf(current.lastTs > ts ? current.lastTs : ts),
					// A turn with no snapshot at all is known only by its settlement,
					// and its calls were the replies; "internal" is what the settlement
					// holds beyond the snapshots the turn did write.
					kind: current.deltas.length === 0 ? KIND_REPLY : KIND_INTERNAL,
					model: current.model,
					provider: current.provider,
				})
			}
		}
		const served =
			typeof settlement?.servingProvider === 'string' ? settlement.servingProvider : undefined
		for (const delta of current.deltas) {
			const provider = delta.provider ?? (current.fellBack ? current.earlyProvider : served) ?? null
			this.#settledSink.add(delta, provider)
		}
	}

	#line(line: string, lineStart: number): void {
		if (!INTERESTING.test(line)) return
		let record: Record<string, unknown>
		try {
			record = JSON.parse(line) as Record<string, unknown>
		} catch {
			return
		}
		const ts = parseTs(record.ts)
		switch (record.type) {
			case 'session_started': {
				const parent = record.parent as { kind?: unknown } | undefined
				if (parent !== undefined && typeof parent.kind === 'string')
					this.#facts.parentKind = parent.kind
				else if (parent !== undefined) this.#facts.parentKind = 'agent_spawn'
				if (typeof record.cwd === 'string') this.#facts.cwd = record.cwd
				const harness = record.harness as { engineId?: unknown } | undefined
				if (harness !== undefined && typeof harness.engineId === 'string') {
					this.#facts.engineId = harness.engineId
				}
				break
			}
			case 'turn_started': {
				// An earlier turn that never settled (a log that was cut) is dropped as
				// open: it has no terminal record to say more.
				const config = record.config as { model?: unknown } | undefined
				this.#turn = {
					startOffset: lineStart,
					deltas: [],
					previous: ZERO,
					model: typeof config?.model === 'string' ? config.model : 'unknown',
					provider: undefined,
					earlyProvider: undefined,
					fellBack: false,
					lastTs: ts ?? 0,
				}
				break
			}
			case 'request_envelope': {
				if (this.#turn !== undefined && typeof record.model === 'string')
					this.#turn.model = record.model
				break
			}
			case 'provider_fallback': {
				const turn = this.#turn
				if (turn === undefined) break
				if (!turn.fellBack) {
					turn.fellBack = true
					turn.earlyProvider =
						typeof record.fromProviderId === 'string' ? record.fromProviderId : undefined
				}
				if (typeof record.toProviderId === 'string') turn.provider = record.toProviderId
				if (typeof record.toModel === 'string') turn.model = record.toModel
				break
			}
			case 'token_usage_updated': {
				const turn = this.#turn
				if (turn === undefined || ts === undefined) break
				const now = cumulativeOf(record.usage, record.cost)
				const step = minus(now, turn.previous)
				turn.previous = now
				turn.lastTs = ts
				if (isZero(step)) break
				turn.deltas.push({
					...step,
					slot: slotOf(ts),
					kind: record.contextMeasuredBy === 'estimate' ? KIND_COMPACTION : KIND_REPLY,
					model: turn.model,
					provider: turn.provider,
				})
				break
			}
			case 'turn_completed':
			case 'turn_failed': {
				const settlement = record.settlement as Record<string, unknown> | undefined
				this.#settle(settlement, ts ?? this.#turn?.lastTs ?? 0)
				break
			}
		}
	}

	finish(): FoldResult {
		let from = this.#tailOffset
		const turn = this.#turn
		if (turn !== undefined) {
			from = turn.startOffset
			const served = turn.fellBack ? turn.earlyProvider : undefined
			for (const delta of turn.deltas) this.#openSink.add(delta, delta.provider ?? served ?? null)
		}
		return {
			settled: this.#settledSink.rows(),
			open: this.#openSink.rows(),
			from,
			facts: this.#facts,
		}
	}
}

/** Fold the complete lines of one in-memory stretch. See {@link LogFolder}. */
export function foldLogChunk(chunk: Buffer, baseOffset: number, models: ModelTable): FoldResult {
	const folder = new LogFolder(models, baseOffset)
	folder.feed(chunk)
	return folder.finish()
}

/** A whole log, in memory. For tests and the per-conversation total. */
export function foldWholeLog(
	log: Buffer | string,
	models: ModelTable = new ModelTable(),
): FoldResult & { readonly rows: SpendRow[] } {
	const buffer = typeof log === 'string' ? Buffer.from(log, 'utf8') : log
	const result = foldLogChunk(buffer, 0, models)
	return { ...result, rows: [...result.settled, ...result.open] }
}
