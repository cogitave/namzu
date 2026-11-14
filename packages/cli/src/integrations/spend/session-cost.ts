/**
 * `session_cost`: the model's read of what this conversation has cost.
 *
 * The person has `/cost`, `namzu cost`, the status line and the Desktop ring;
 * this is the same record for the model, so a cost question is answered in one
 * step instead of a search of the disk for a file that is not there. It folds
 * the conversation's own session log with the fold the spend ledger uses, so
 * the two cannot disagree, and it prices nothing itself: every figure is the
 * one the kernel stamped on the call when it was made.
 */

import { createReadStream } from 'node:fs'
import { defineTool, mcpJsonSchemaToZod } from '@namzu/sdk'
import type { CostInfo, ToolContext, ToolDefinition } from '@namzu/sdk'

import { type Cumulative, LogFolder, ModelTable } from './fold.js'
import { type LedgerSession, READ_CHUNK_BYTES } from './ledger.js'
import { conversationTotals } from './report.js'

/** The tool's name, as the model calls it. */
export const SESSION_COST_TOOL = 'session_cost'

/** What a conversation's log says it cost so far. */
export interface SessionCostReading {
	/** Tokens the calls used, as the drivers counted them. */
	readonly tokens: number
	readonly cachedTokens: number
	readonly outputTokens: number
	/** Money at the prices the kernel stamped, and the tokens it had no price for. */
	readonly cost: CostInfo
	/** The turn that settled last, or `undefined` while none has. */
	readonly lastTurn?: {
		readonly cost: CostInfo
		readonly tokens: number
		readonly outputTokens: number
	}
	/** Providers that answered in this conversation, by id, as its assistant messages name them. */
	readonly providers: readonly string[]
	/** Whether the log holds any model call at all. */
	readonly hasCalls: boolean
}

const costInfo = (totalCost: number, unpricedTokens: number): CostInfo => ({
	totalCost,
	cacheDiscount: 0,
	unpricedTokens,
})

const cumulativeCost = (c: Cumulative): CostInfo => costInfo(c.cost, c.unpriced)

/** How an assistant message names the provider that answered it. */
const PROVIDER_MARK = /"source":\{"type":"model","providerId":"([A-Za-z0-9._-]{1,64})"/g

/** The bytes of one conversation's log, as the kernel wrote them. */
export type SessionLogBytes = AsyncIterable<Uint8Array>

/** A log file read in pieces; a file that does not exist yet reads as an empty log. */
export async function* fileLogBytes(path: string): SessionLogBytes {
	try {
		for await (const chunk of createReadStream(path, { highWaterMark: READ_CHUNK_BYTES })) {
			yield chunk as Buffer
		}
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
	}
}

/** Fold one session log, whole. An empty log is a conversation with no calls yet. */
export async function readSessionCost(bytes: SessionLogBytes): Promise<SessionCostReading> {
	const models = new ModelTable()
	const folder = new LogFolder(models, 0)
	let size = 0
	// The fold keeps no provider for a turn still running, and the log names the
	// provider on each assistant message, so the same pass collects those names.
	const providers = new Set<string>()
	let carry = ''
	for await (const piece of bytes) {
		const chunk = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength)
		size += chunk.length
		folder.feed(chunk)
		const text = carry + chunk.toString('latin1')
		for (const match of text.matchAll(PROVIDER_MARK)) providers.add(match[1] as string)
		carry = text.slice(-96)
	}
	const result = folder.finish()
	const session: LedgerSession = {
		slug: '',
		size,
		mtimeMs: 0,
		from: result.from,
		rows: result.settled,
		open: result.open,
	}
	const totals = conversationTotals(session)
	const last = folder.lastSettled
	return {
		tokens: totals.tokens,
		cachedTokens: totals.cacheReadTokens,
		outputTokens: totals.outputTokens,
		cost: costInfo(totals.estimatedCostUsd, totals.unpricedTokens),
		...(last
			? {
					lastTurn: {
						cost: cumulativeCost(last),
						tokens: last.total,
						outputTokens: last.completion,
					},
				}
			: {}),
		providers: [...providers].sort(),
		hasCalls: totals.tokens > 0 || result.settled.length + result.open.length > 0,
	}
}

const fmt = (n: number): string => n.toLocaleString('en-US')

/**
 * Money to four decimals, so a small conversation keeps its precision (the
 * SDK's `describeCost` rounds to cents above one cent), with the same
 * unknown-price wording: a total that leaves tokens out is a floor, and a
 * total of nothing but unknown tokens is "unknown", never `$0`.
 */
function describeMoney(cost: CostInfo): string {
	if (cost.unpricedTokens === 0) return `$${cost.totalCost.toFixed(4)}`
	if (cost.totalCost === 0) return `unknown (${fmt(cost.unpricedTokens)} tokens at no known rate)`
	return `at least $${cost.totalCost.toFixed(4)} (${fmt(cost.unpricedTokens)} tokens at no known rate)`
}

/** Where the money figure comes from, said in words, or `undefined` when no money is counted. */
function sourceOf(reading: SessionCostReading): string | undefined {
	if (reading.cost.totalCost <= 0) return undefined
	const providers = reading.providers
	if (providers.length === 0) return undefined
	if (providers.length === 1 && providers[0] === 'openrouter') {
		return 'Source: the charge OpenRouter reported for each call.'
	}
	if (providers.includes('openrouter')) {
		return 'Source: the charge OpenRouter reported for its calls, and list prices for the others.'
	}
	return 'Source: an estimate from list prices (the provider reports no charge).'
}

/** The text the model reads. Plain lines, money first, never a bare 0 for an unknown price. */
export function renderSessionCost(reading: SessionCostReading): string {
	if (!reading.hasCalls) {
		return 'No cost is recorded for this conversation yet (no model call has finished). That is not the same as free; the provider\u2019s dashboard has the account total.'
	}
	const lines: string[] = []
	const { cost } = reading
	if (cost.unpricedTokens > 0 && cost.totalCost === 0) {
		lines.push(
			`This conversation so far: price not known. ${describeMoney(cost)}. Do not report this as free or as 0; say the price for this model is not known and give the token counts instead.`,
		)
	} else {
		lines.push(`This conversation so far: ${describeMoney(cost)}.`)
		if (cost.unpricedTokens > 0) {
			lines.push(
				`${fmt(cost.unpricedTokens)} tokens have no known rate, so the real cost is higher than this.`,
			)
		}
	}
	const source = sourceOf(reading)
	if (source) lines.push(source)
	if (reading.lastTurn) {
		const { cost: last } = reading.lastTurn
		lines.push(
			last.unpricedTokens > 0 && last.totalCost === 0
				? `Last completed turn: price not known (${fmt(last.unpricedTokens)} tokens at no known rate).`
				: `Last completed turn: ${describeMoney(last)}.`,
		)
	}
	lines.push(
		`Tokens: ${fmt(reading.tokens)} in total, of which ${fmt(reading.cachedTokens)} read from the cache and ${fmt(reading.outputTokens)} generated.`,
	)
	lines.push(
		'Not included: side requests such as the conversation title, and the work of sub-agents (their own conversations). The provider’s dashboard has the account total.',
	)
	return lines.join('\n')
}

/**
 * The tool. `resolveLog` names the conversation of the turn that called it,
 * as the conversation-search tools do, so a tool call can only read its own.
 */
export function buildSessionCostTool(
	resolveLog: (context: ToolContext) => SessionLogBytes,
): ToolDefinition {
	return defineTool({
		name: SESSION_COST_TOOL,
		description:
			'Answers questions about what this conversation has cost: money spent so far and in the last completed turn, with where the figure comes from, plus token totals. Use it for any question about cost, price, spend or usage of this conversation. Takes no arguments.',
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {},
			additionalProperties: false,
		}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute(_input, context) {
			try {
				const reading = await readSessionCost(resolveLog(context))
				return { success: true, output: renderSessionCost(reading) }
			} catch {
				return {
					success: false,
					output: '',
					error: 'The cost of this conversation could not be read just now.',
				}
			}
		},
	})
}
