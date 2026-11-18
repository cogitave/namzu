import type { SessionEvent } from '@namzu/sdk'

import type { ContextGathering } from '../integrations/sessions/context-gather.js'

/**
 * The desktop's context panel: where a conversation's window goes. The desktop
 * asks (it is not pushed), once when the panel opens and again on each usage
 * notice while it stays open.
 *
 * Absent means "the engine did not say". Sizes are whole numbers of tokens.
 * Nothing here carries file contents, and a file is named only by the short
 * label the terminal's `/context` already prints.
 */
export const CONTEXT_REQUEST = 'namzu/session/context'

/** How many entries one list on the wire may hold. */
export const CONTEXT_LIST_LIMIT = 500

export type ContextDetail = 'summary' | 'full'

export interface ContextRequest {
	readonly sessionId: string
	readonly detail: ContextDetail
}

/** Reads the request's params, or says what was wrong in a sentence a person can read. */
export function readContextRequest(params: unknown): ContextRequest {
	const wrong = 'Invalid context request.'
	if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error(wrong)
	const row = params as Record<string, unknown>
	if (Object.keys(row).some((key) => key !== 'sessionId' && key !== 'detail'))
		throw new Error(wrong)
	if (typeof row.sessionId !== 'string' || row.sessionId.length === 0) throw new Error(wrong)
	if (row.detail !== undefined && row.detail !== 'summary' && row.detail !== 'full')
		throw new Error(wrong)
	return { sessionId: row.sessionId, detail: row.detail ?? 'summary' }
}

export interface ContextFigures {
	readonly tokens?: number
	readonly windowTokens?: number
	readonly measuredBy?: 'provider' | 'estimate'
	readonly windowSource?: 'config' | 'provider' | 'model-table' | 'default'
	/** A shortening rewrote the history after the last report from the AI service. */
	readonly sizeOutOfDate?: boolean
	/** Moves each time a turn or a shortening ends: the lists are read again after that. */
	readonly version: number
}

type Writable<T> = { -readonly [K in keyof T]: T[K] }

const finite = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0

export interface ContextTracker {
	observe(sessionId: string, event: SessionEvent): void
	figures(sessionId: string): ContextFigures | undefined
	forget(sessionId: string): void
}

/** The last size figures per conversation, kept from the engine's own events. */
export function createContextTracker(): ContextTracker {
	const sessions = new Map<string, Writable<ContextFigures>>()
	const entry = (id: string) => {
		let found = sessions.get(id)
		if (!found) {
			found = { version: 0 }
			sessions.set(id, found)
		}
		return found
	}
	return {
		observe(sessionId, event) {
			if (event.type === 'token_usage_updated') {
				if (!finite(event.contextWindowTokens) || event.contextWindowTokens <= 0) return
				const figures = entry(sessionId)
				figures.windowTokens = event.contextWindowTokens
				if (finite(event.contextTokens)) figures.tokens = event.contextTokens
				if (event.contextMeasuredBy) figures.measuredBy = event.contextMeasuredBy
				if (event.windowSource) figures.windowSource = event.windowSource
				if (event.contextMeasuredBy === 'provider') delete figures.sizeOutOfDate
			} else if (event.type === 'compaction_completed') {
				const figures = entry(sessionId)
				if (finite(event.tokensAfter)) {
					figures.tokens = event.tokensAfter
					// What follows a pass is the kernel's own count of what is left.
					figures.measuredBy = 'estimate'
				}
				if (finite(event.contextWindowTokens) && event.contextWindowTokens > 0)
					figures.windowTokens = event.contextWindowTokens
				figures.sizeOutOfDate = true
				figures.version += 1
			} else if (
				event.type === 'turn_completed' ||
				event.type === 'turn_failed' ||
				event.type === 'turn_paused'
			) {
				const figures = sessions.get(sessionId)
				if (figures) figures.version += 1
			}
		},
		figures: (sessionId) => sessions.get(sessionId),
		forget: (sessionId) => {
			sessions.delete(sessionId)
		},
	}
}

export interface ContextReportCategory {
	readonly id: string
	readonly name: string
	readonly tokens: number
	readonly kind: 'used' | 'deferred' | 'buffer' | 'free'
}

export interface ContextReportList {
	readonly mcpTools: readonly { name: string; server: string; tokens: number }[]
	readonly deferredTools: readonly { name: string; server?: string; tokens: number }[]
	readonly skills: readonly { name: string; source: string; tokens: number }[]
	readonly agents: readonly { name: string; source: string; tokens: number }[]
	readonly memoryFiles: readonly { label: string; tokens: number }[]
}

export interface ContextReport {
	readonly sessionId: string
	readonly detail: ContextDetail
	readonly measuredBy?: 'provider' | 'estimate'
	readonly windowTokens: number
	readonly windowSource?: 'config' | 'provider' | 'model-table' | 'default'
	readonly totalTokens: number
	readonly percentage: number
	readonly autoCompact: {
		readonly enabled: boolean
		readonly bufferTokens: number
		readonly thresholdTokens?: number
	}
	readonly categories: readonly ContextReportCategory[]
	readonly lists?: ContextReportList
	readonly sizeOutOfDate?: boolean
	/** True when the total is the kernel's own count, or the history changed since the last count. */
	readonly approximate: boolean
}

/** A tool server's tool as a person names it: the part after the server's own prefix. */
function toolLabel(name: string, server: string): string {
	const prefix = `mcp__${server}__`
	return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

const bySize = <T extends { tokens: number }>(rows: readonly T[]): T[] =>
	[...rows].sort((a, b) => b.tokens - a.tokens).slice(0, CONTEXT_LIST_LIMIT)

/** Shapes what the shared gathering found into the wire answer. */
export function buildContextReport(input: {
	readonly sessionId: string
	readonly detail: ContextDetail
	readonly figures: ContextFigures
	readonly autoCompact: boolean
	readonly gathering: ContextGathering
}): ContextReport {
	const { breakdown, mcp, deferredBuiltIn, deferredMcp, memory, skillSizes, agentSizes } =
		input.gathering
	const { figures } = input
	const threshold = input.autoCompact
		? Math.max(0, breakdown.windowTokens - breakdown.bufferTokens)
		: undefined
	const lists: ContextReportList | undefined =
		input.detail === 'full'
			? {
					mcpTools: bySize(
						mcp.map((tool) => ({
							name: toolLabel(tool.name, tool.server ?? ''),
							server: tool.server ?? '',
							tokens: tool.tokens,
						})),
					),
					deferredTools: bySize(
						[...deferredBuiltIn, ...deferredMcp].map((tool) => ({
							name: tool.server === undefined ? tool.name : toolLabel(tool.name, tool.server),
							...(tool.server === undefined ? {} : { server: tool.server }),
							tokens: tool.tokens,
						})),
					),
					skills: bySize(
						skillSizes.map(({ skill, tokens }) => ({
							name: skill.name,
							source: skill.source,
							tokens,
						})),
					),
					agents: bySize(
						agentSizes.map(({ agent, tokens }) => ({
							name: agent.name,
							source: agent.source,
							tokens,
						})),
					),
					memoryFiles: bySize(memory.map((file) => ({ label: file.label, tokens: file.tokens }))),
				}
			: undefined
	const approximate = figures.measuredBy !== 'provider' || figures.sizeOutOfDate === true
	return {
		sessionId: input.sessionId,
		detail: input.detail,
		...(figures.measuredBy ? { measuredBy: figures.measuredBy } : {}),
		windowTokens: breakdown.windowTokens,
		...(figures.windowSource ? { windowSource: figures.windowSource } : {}),
		totalTokens: breakdown.totalTokens,
		percentage: breakdown.percentage,
		autoCompact: {
			enabled: input.autoCompact,
			bufferTokens: breakdown.bufferTokens,
			...(threshold !== undefined ? { thresholdTokens: threshold } : {}),
		},
		categories: breakdown.categories.map(({ id, name, tokens, kind }) => ({
			id,
			name,
			tokens: Math.round(tokens),
			kind,
		})),
		...(lists ? { lists } : {}),
		...(figures.sizeOutOfDate ? { sizeOutOfDate: true } : {}),
		approximate,
	}
}
