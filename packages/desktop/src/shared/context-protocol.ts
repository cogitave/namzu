/**
 * What the Namzu host says about where a conversation's window goes, read before
 * anything trusts it. The desktop half of `packages/cli/src/commands/desktop-context.ts`:
 * the request is `namzu/session/context`, and every field the engine did not say is absent.
 */
export const CONTEXT_REQUEST = 'namzu/session/context'

export type ContextDetail = 'summary' | 'full'
export type ContextKind = 'used' | 'deferred' | 'buffer' | 'free'

export interface ContextCategory {
	/** The engine's own name for the row; the panel words it itself. */
	id: string
	name: string
	tokens: number
	kind: ContextKind
}

export interface ContextLists {
	mcpTools: { name: string; server: string; tokens: number }[]
	deferredTools: { name: string; server?: string; tokens: number }[]
	skills: { name: string; source: string; tokens: number }[]
	agents: { name: string; source: string; tokens: number }[]
	memoryFiles: { label: string; tokens: number }[]
}

export interface ContextReport {
	detail: ContextDetail
	measuredBy?: 'provider' | 'estimate'
	windowTokens: number
	windowSource?: 'config' | 'provider' | 'model-table' | 'default'
	totalTokens: number
	percentage: number
	autoCompact: { enabled: boolean; bufferTokens: number; thresholdTokens?: number }
	categories: ContextCategory[]
	lists?: ContextLists
	sizeOutOfDate?: boolean
	approximate: boolean
}

const MAX_COUNT = 1e12
const MAX_ROWS = 600
const MAX_TEXT = 300

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_COUNT
		? Math.round(value)
		: undefined
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT
		? value
		: undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function rows<T>(value: unknown, read: (row: Record<string, unknown>) => T | undefined): T[] {
	if (!Array.isArray(value)) return []
	const out: T[] = []
	for (const item of value.slice(0, MAX_ROWS)) {
		const row = record(item)
		const read1 = row ? read(row) : undefined
		if (read1 !== undefined) out.push(read1)
	}
	return out
}

/** Admit only the known fields; a row that does not read is left out. Null when there is no window. */
export function readContextReport(value: unknown): ContextReport | null {
	const raw = record(value)
	if (!raw) return null
	const windowTokens = count(raw.windowTokens)
	const totalTokens = count(raw.totalTokens)
	const percentage = count(raw.percentage)
	if (windowTokens === undefined || windowTokens === 0) return null
	if (totalTokens === undefined || percentage === undefined) return null
	const categories = rows(raw.categories, (row): ContextCategory | undefined => {
		const id = text(row.id)
		const name = text(row.name)
		const tokens = count(row.tokens)
		const kind = row.kind
		if (!id || !name || tokens === undefined) return undefined
		if (kind !== 'used' && kind !== 'deferred' && kind !== 'buffer' && kind !== 'free')
			return undefined
		return { id, name, tokens, kind }
	})
	const auto = record(raw.autoCompact)
	const bufferTokens = count(auto?.bufferTokens)
	const threshold = count(auto?.thresholdTokens)
	const listsRaw = record(raw.lists)
	const lists: ContextLists | undefined = listsRaw
		? {
				mcpTools: rows(listsRaw.mcpTools, (row) => {
					const name = text(row.name)
					const tokens = count(row.tokens)
					return name && tokens !== undefined
						? { name, server: text(row.server) ?? '', tokens }
						: undefined
				}),
				deferredTools: rows(listsRaw.deferredTools, (row) => {
					const name = text(row.name)
					const tokens = count(row.tokens)
					const server = text(row.server)
					return name && tokens !== undefined
						? { name, ...(server ? { server } : {}), tokens }
						: undefined
				}),
				skills: rows(listsRaw.skills, (row) => {
					const name = text(row.name)
					const tokens = count(row.tokens)
					return name && tokens !== undefined
						? { name, source: text(row.source) ?? '', tokens }
						: undefined
				}),
				agents: rows(listsRaw.agents, (row) => {
					const name = text(row.name)
					const tokens = count(row.tokens)
					return name && tokens !== undefined
						? { name, source: text(row.source) ?? '', tokens }
						: undefined
				}),
				memoryFiles: rows(listsRaw.memoryFiles, (row) => {
					const label = text(row.label)
					const tokens = count(row.tokens)
					return label && tokens !== undefined ? { label, tokens } : undefined
				}),
			}
		: undefined
	const source = raw.windowSource
	return {
		detail: raw.detail === 'full' ? 'full' : 'summary',
		...(raw.measuredBy === 'provider' || raw.measuredBy === 'estimate'
			? { measuredBy: raw.measuredBy }
			: {}),
		windowTokens,
		...(source === 'config' ||
		source === 'provider' ||
		source === 'model-table' ||
		source === 'default'
			? { windowSource: source }
			: {}),
		totalTokens,
		percentage,
		autoCompact: {
			enabled: auto?.enabled === true,
			bufferTokens: bufferTokens ?? 0,
			...(threshold === undefined ? {} : { thresholdTokens: threshold }),
		},
		categories,
		...(lists ? { lists } : {}),
		...(raw.sizeOutOfDate === true ? { sizeOutOfDate: true } : {}),
		approximate: raw.approximate !== false,
	}
}
