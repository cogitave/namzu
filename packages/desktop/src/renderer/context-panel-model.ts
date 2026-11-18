import type { ContextCategory, ContextLists, ContextReport } from '../shared/context-protocol.js'

/**
 * What the context panel shows, worked out from the engine's answer. Pure: the panel only draws it.
 *
 * Words are plain. "Token" appears only in the footnote and in hover text, where a person who
 * looks for the unit finds it.
 */

/** A size for a row: 412, 19.6k, 889.3k, 1M. One decimal at most. */
export function formatSize(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return '0'
	const scaled = (value: number, unit: string): string => {
		const text = value.toFixed(1)
		return `${text.endsWith('.0') ? text.slice(0, -2) : text}${unit}`
	}
	if (count < 1000) return String(Math.round(count))
	if (count < 1_000_000) {
		const thousands = count / 1000
		// 999.96k would round up to 1000k; say 1M instead.
		return thousands >= 999.95 ? '1M' : scaled(thousands, 'k')
	}
	return scaled(count / 1_000_000, 'M')
}

/** A share of the window: one decimal under 10%, whole from there, "<0.1%" for a sliver. */
export function formatShare(tokens: number, windowTokens: number): string {
	if (!(windowTokens > 0) || !(tokens > 0)) return '0%'
	const share = (tokens / windowTokens) * 100
	if (share < 0.1) return '<0.1%'
	return share < 10 ? `${share.toFixed(1)}%` : `${Math.round(share)}%`
}

/** The colour slots the panel draws with (`--context-c1` to `--context-c8`), by category. */
const SLOT: Record<string, number> = {
	messages: 1,
	'mcp-tools': 2,
	'system-tools': 3,
	'system-prompt': 4,
	skills: 5,
	memory: 6,
	agents: 7,
	'mcp-instructions': 8,
}

const NAME: Record<string, string> = {
	messages: 'Messages',
	'system-tools': 'Built-in tools',
	'mcp-tools': 'Tool server tools',
	'system-prompt': 'Namzu’s instructions',
	skills: 'Skills',
	memory: 'Project notes',
	agents: 'Custom agents',
	'mcp-instructions': 'Tool server notes',
	'deferred-tools': 'Built-in tools',
	'deferred-mcp-tools': 'Tool server tools',
}

/** What each row is, for hover text. The engine's own name follows, for a person who looks for it. */
const HINT: Record<string, string> = {
	messages: 'What you and Namzu have said, and what tools returned.',
	'system-tools': 'The definitions of the tools built into Namzu.',
	'mcp-tools': 'The definitions of the tools your connected tool servers offer.',
	'system-prompt': 'Namzu’s own standing instructions for this conversation.',
	skills: 'The short descriptions of the skills Namzu can use.',
	memory: 'Notes and instruction files from your project and your own folder.',
	agents: 'The custom agents Namzu can hand work to.',
	'mcp-instructions': 'What your tool servers say about how to use them.',
}

export interface PanelRow {
	id: string
	name: string
	size: string
	share: string
	/** `--context-cN`, or undefined for a row with no colour of its own. */
	slot?: number
	/** The tooltip: what the row is, then the exact count. */
	title: string
	/** The list under the row, when it has one. */
	items?: PanelItem[]
}

export interface PanelItem {
	name: string
	size: string
	/** A muted note after the name, such as where a skill comes from. */
	note?: string
}

export interface PanelSegment {
	id: string
	name: string
	/** Share of the bar, in percent. */
	width: number
	slot?: number
	kind: 'used' | 'reserve'
	title: string
}

export interface PanelServer {
	name: string
	count: number
	size: string
	tools: PanelItem[]
}

export interface PanelModel {
	/** "8% used" or "about 8% used". */
	headline: string
	/** "77.7k of 1M" or "about 77.7k of 1M". */
	size: string
	/** The small tag: the AI service counted it, or Namzu did. Absent when the engine did not say. */
	tag?: { text: string; title: string }
	/** The one sentence under the figures. */
	sentence: string
	tone: 'normal' | 'high' | 'full'
	bar: { label: string; segments: PanelSegment[] }
	used: PanelRow[]
	deferred: PanelRow[]
	deferredNote?: string
	reserve: PanelRow[]
	servers?: { total: string; list: PanelServer[] }
	footnote: string
}

const describe = (tokens: number, label: string): string =>
	`${label}: ${tokens.toLocaleString('en-US')} tokens`

function listItems(id: string, lists: ContextLists | undefined): PanelItem[] | undefined {
	if (!lists) return undefined
	const sorted = <T extends { tokens: number }>(rows: T[]) =>
		[...rows].sort((a, b) => b.tokens - a.tokens)
	if (id === 'skills' && lists.skills.length > 0)
		return sorted(lists.skills).map((row) => ({
			name: row.name,
			size: formatSize(row.tokens),
			...(row.source ? { note: row.source } : {}),
		}))
	if (id === 'agents' && lists.agents.length > 0)
		return sorted(lists.agents).map((row) => ({
			name: row.name,
			size: formatSize(row.tokens),
			...(row.source ? { note: row.source } : {}),
		}))
	if (id === 'memory' && lists.memoryFiles.length > 0)
		return sorted(lists.memoryFiles).map((row) => ({
			name: row.label,
			size: formatSize(row.tokens),
		}))
	return undefined
}

function toServers(lists: ContextLists | undefined): PanelModel['servers'] {
	if (!lists) return undefined
	const byServer = new Map<string, { tools: PanelItem[]; tokens: number; sort: number[] }>()
	const add = (server: string, name: string, tokens: number, note?: string) => {
		const entry = byServer.get(server) ?? { tools: [], tokens: 0, sort: [] }
		entry.tools.push({ name, size: formatSize(tokens), ...(note ? { note } : {}) })
		entry.sort.push(tokens)
		entry.tokens += tokens
		byServer.set(server, entry)
	}
	for (const tool of [...lists.mcpTools].sort((a, b) => b.tokens - a.tokens))
		add(tool.server || 'Other', tool.name, tool.tokens)
	for (const tool of [...lists.deferredTools]
		.filter((row) => row.server !== undefined)
		.sort((a, b) => b.tokens - a.tokens))
		add(tool.server ?? 'Other', tool.name, tool.tokens, 'loads when needed')
	if (byServer.size === 0) return undefined
	const list = [...byServer.entries()]
		.sort((a, b) => b[1].tokens - a[1].tokens)
		.map(([name, entry]) => ({
			name,
			count: entry.tools.length,
			size: formatSize(entry.tokens),
			tools: entry.tools,
		}))
	const count = list.reduce((n, server) => n + server.count, 0)
	return { total: `${count} ${count === 1 ? 'tool' : 'tools'}`, list }
}

export interface PanelInput {
	report: ContextReport
	/** Lists from an earlier full answer, kept while a short one refreshes the figures. */
	lists?: ContextLists | undefined
	/** A shortening is running now. */
	compacting?: boolean
}

export function contextPanelModel(input: PanelInput): PanelModel {
	const { report } = input
	const lists = report.lists ?? input.lists
	const window = report.windowTokens
	const total = report.totalTokens
	const about = report.measuredBy === 'provider' && !report.sizeOutOfDate ? '' : 'about '
	const rawPercent = window > 0 ? (total / window) * 100 : 0
	const percent = total > 0 && Math.round(rawPercent) === 0 ? '<1' : String(Math.round(rawPercent))
	const tone = rawPercent >= 90 ? 'full' : rawPercent >= 75 ? 'high' : 'normal'

	const byTokens = (a: ContextCategory, b: ContextCategory) => b.tokens - a.tokens
	const rowOf = (category: ContextCategory, deferred: boolean): PanelRow => {
		const name = NAME[category.id] ?? category.name
		const hint = HINT[category.id]
		const slot = deferred ? undefined : SLOT[category.id]
		const items = deferred ? undefined : listItems(category.id, lists)
		return {
			id: category.id,
			name,
			size: formatSize(category.tokens),
			share: deferred ? '-' : formatShare(category.tokens, window),
			...(slot === undefined ? {} : { slot }),
			title: [
				hint,
				describe(category.tokens, category.name),
				deferred ? 'Not in the conversation yet. Namzu loads it if it needs it.' : undefined,
			]
				.filter(Boolean)
				.join(' '),
			...(items ? { items } : {}),
		}
	}
	const used = report.categories.filter((c) => c.kind === 'used' && c.tokens > 0).sort(byTokens)
	const deferred = report.categories
		.filter((c) => c.kind === 'deferred' && c.tokens > 0)
		.sort(byTokens)
	const buffer = report.categories.find((c) => c.kind === 'buffer' && c.tokens > 0)
	const free = report.categories.find((c) => c.kind === 'free')

	const reserve: PanelRow[] = []
	if (buffer)
		reserve.push({
			id: 'buffer',
			name: report.autoCompact.enabled ? 'Kept free for the next answer' : 'Kept free to shorten',
			size: formatSize(buffer.tokens),
			share: formatShare(buffer.tokens, window),
			title: describe(
				buffer.tokens,
				report.autoCompact.enabled
					? 'Room Namzu keeps so it can answer and shorten the conversation'
					: 'Room kept so you can shorten the conversation yourself',
			),
		})
	if (free)
		reserve.push({
			id: 'free',
			name: 'Free space',
			size: formatSize(free.tokens),
			share: formatShare(free.tokens, window),
			title: describe(free.tokens, 'Free space'),
		})

	// The bar is the window; if the conversation overflows it, the bar is the conversation.
	const usedTotal = used.reduce((n, c) => n + c.tokens, 0)
	const span = Math.max(window, usedTotal + (buffer?.tokens ?? 0))
	const width = (tokens: number) => (span > 0 ? (tokens / span) * 100 : 0)
	const segments: PanelSegment[] = used.map((category) => {
		const slot = SLOT[category.id]
		return {
			id: category.id,
			name: NAME[category.id] ?? category.name,
			width: width(category.tokens),
			...(slot === undefined ? {} : { slot }),
			kind: 'used',
			title: `${NAME[category.id] ?? category.name} · ${formatSize(category.tokens)} · ${formatShare(category.tokens, window)}`,
		}
	})
	if (buffer)
		segments.push({
			id: 'buffer',
			name: 'Kept free',
			width: width(buffer.tokens),
			kind: 'reserve',
			title: `Kept free · ${formatSize(buffer.tokens)} · ${formatShare(buffer.tokens, window)}`,
		})

	const label = `${about}${percent}% used: ${used
		.map((c) => `${(NAME[c.id] ?? c.name).toLowerCase()} ${formatShare(c.tokens, window)}`)
		.join(', ')}`

	let sentence: string
	const threshold = report.autoCompact.thresholdTokens
	if (input.compacting) sentence = 'Namzu is shortening this conversation…'
	else if (rawPercent >= 90 && report.autoCompact.enabled)
		sentence = 'Namzu will shorten this conversation soon.'
	else if (report.autoCompact.enabled && threshold !== undefined)
		sentence =
			total >= threshold
				? 'Namzu will shorten this conversation soon.'
				: `About ${formatSize(threshold - total)} left before Namzu shortens this conversation.`
	else if (window > total)
		sentence = `About ${formatSize(window - total)} left in this conversation.`
	else sentence = 'This conversation is past what Namzu can read at once.'

	let footnote: string
	if (report.sizeOutOfDate)
		footnote =
			'Namzu shortened this conversation, so these sizes are out of date until your next message. Sizes are Namzu’s own count (about 4 characters to a token).'
	else if (report.measuredBy === 'provider')
		footnote =
			'The total comes from your AI service. The rows are Namzu’s own estimates (about 4 characters to a token) and add up to it.'
	else
		footnote =
			'Sizes are Namzu’s own count (about 4 characters to a token). They may be off by a few percent until your next message.'

	const tag =
		report.measuredBy === 'provider' && !report.sizeOutOfDate
			? { text: 'Exact total', title: 'Your AI service counted this.' }
			: report.measuredBy
				? {
						text: 'Estimate',
						title: 'Namzu counted this itself. It may be off by a few percent.',
					}
				: undefined

	const servers = toServers(lists)
	return {
		headline: `${about}${percent}% used`,
		size: `${about}${formatSize(total)} of ${formatSize(window)}`,
		...(tag ? { tag } : {}),
		sentence,
		tone,
		bar: { label, segments },
		used: used.map((c) => rowOf(c, false)),
		deferred: deferred.map((c) => rowOf(c, true)),
		...(deferred.length > 0
			? { deferredNote: 'These aren’t in the conversation yet. Namzu loads them if it needs them.' }
			: {}),
		reserve,
		...(servers ? { servers } : {}),
		footnote,
	}
}
