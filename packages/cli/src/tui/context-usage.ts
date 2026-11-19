/**
 * Gathers what `/context` needs from a live session and hands it to the
 * arithmetic and the view.
 *
 * The sizes are estimates by characters, the same way the kernel estimates a
 * request it has not yet sent; the measured total from the provider, when
 * there is one, replaces the guess for the conversation as a whole.
 */

import type { AgentFileDefinition } from '@namzu/sdk'
import type { Message } from '@namzu/sdk'

import type { SkillsConfig } from '../config/schema.js'
import {
	describeCacheLifetime,
	promptCacheTtl,
	providerOffersCacheLifetime,
} from '../integrations/providers/prompt-cache-ttl.js'
import { discoverContextLists, gatherContext } from '../integrations/sessions/context-gather.js'
import type { SkillInfo } from '../skills/store.js'
import type { AgentSession } from './agent.js'
import {
	type ContextListGroup,
	type ContextSection,
	type ContextView,
	buildContextView,
	formatSkillTokens,
	formatTokens,
	withContextNotes,
} from './context-grid.js'
import { displayPath } from './display-path.js'
import { type SlashContext, contextCleanupLines, renderContext } from './slashCommands.js'

/**
 * The window compaction measures against. A configured auto-compact window
 * lowers the model's window (it can never raise it), so what the meter and
 * `/context` call the window is the smaller of the two, and it came from the
 * configuration.
 */
export function effectiveContextWindow(
	reported: {
		readonly windowTokens: number
		readonly windowSource?: ContextSources['context']['windowSource']
	},
	autoCompactWindowTokens: number | undefined,
): {
	readonly windowTokens: number
	readonly windowSource?: ContextSources['context']['windowSource']
	readonly windowAssumed: boolean
	/** The auto-compact size asked for, when it is above the model's window and was capped to it. */
	readonly windowRequested?: number
} {
	const capped =
		autoCompactWindowTokens !== undefined &&
		autoCompactWindowTokens > 0 &&
		autoCompactWindowTokens > reported.windowTokens
	const lowered =
		autoCompactWindowTokens !== undefined &&
		autoCompactWindowTokens > 0 &&
		autoCompactWindowTokens < reported.windowTokens
	const source = lowered ? 'config' : reported.windowSource
	return {
		windowTokens: lowered ? (autoCompactWindowTokens as number) : reported.windowTokens,
		...(source ? { windowSource: source } : {}),
		windowAssumed: source !== 'provider' && source !== 'config',
		...(capped ? { windowRequested: autoCompactWindowTokens as number } : {}),
	}
}

export interface ContextSources {
	/** The latest report from the kernel; the view needs its window. */
	readonly context: {
		readonly tokens: number
		readonly windowTokens: number
		readonly measured: boolean
		readonly windowAssumed: boolean
		readonly windowSource?: 'config' | 'provider' | 'model-table' | 'default'
		/** See `effectiveContextWindow`: the auto-compact size that the model's window capped. */
		readonly windowRequested?: number
	}
	/**
	 * The conversation was rewritten (compacted, summarised in part) since that
	 * report, so its size is out of date. The conversation's share is then
	 * estimated from `messages` and the figures are marked approximate.
	 */
	readonly sizeOutOfDate?: boolean
	readonly terminalColumns: number
	readonly model?: string
	readonly autoCompact: boolean
	/** The prompt cache lifetime in use, as words; absent when there is nothing to show. */
	readonly cacheLifetime?: string
	readonly systemPrompt?: string
	readonly tools: readonly { name: string; tokens: number; server?: string }[]
	/** Tools that load only when needed. */
	readonly deferredTools?: readonly { name: string; tokens: number; server?: string }[]
	readonly messages: readonly Message[]
	/** Absolute paths of the instruction files in force. */
	readonly instructionFiles: readonly string[]
	readonly mcpInstructions: readonly string[]
	readonly skills: readonly SkillInfo[]
	readonly agents: readonly AgentFileDefinition[]
	/** A path as a person reads it. */
	readonly displayPath: (path: string) => string
	readonly readText?: (path: string) => Promise<string>
}

const SOURCE_ORDER = ['Project', 'User', 'Built-in'] as const

function sourceLabel(source: string): string {
	if (source === 'project') return 'Project'
	if (source === 'user') return 'User'
	if (source === 'system') return 'Built-in'
	return source.length > 0 ? source[0]?.toUpperCase() + source.slice(1) : 'Other'
}

function groupBySource<T>(
	items: readonly T[],
	source: (item: T) => string,
	toItem: (item: T) => { label: string; value: string; tokens: number },
): ContextListGroup[] {
	const groups = new Map<string, { label: string; value: string; tokens: number }[]>()
	for (const item of items) {
		const label = sourceLabel(source(item))
		groups.set(label, [...(groups.get(label) ?? []), toItem(item)])
	}
	return [...groups.entries()]
		.sort(([a], [b]) => {
			const rank = (x: string) => {
				const i = (SOURCE_ORDER as readonly string[]).indexOf(x)
				return i === -1 ? SOURCE_ORDER.length : i
			}
			return rank(a) - rank(b)
		})
		.map(([heading, entries]) => ({
			heading,
			items: entries
				.sort((a, b) => b.tokens - a.tokens)
				.map(({ label, value }) => ({ label, value })),
		}))
}

/** A server's tool as a person names it: the part after the server's own prefix. */
function mcpLabel(name: string, server: string): string {
	const prefix = `mcp__${server}__`
	const tool = name.startsWith(prefix) ? name.slice(prefix.length) : name
	return `${server} · ${tool}`
}

export async function collectContextView(sources: ContextSources): Promise<ContextView> {
	const { breakdown, windowSource, mcp, memory, skillSizes, agentSizes } = await gatherContext({
		...sources,
		context: {
			tokens: sources.context.tokens,
			windowTokens: sources.context.windowTokens,
			measured: sources.context.measured,
			...(sources.context.windowSource ? { windowSource: sources.context.windowSource } : {}),
		},
	})
	const source = windowSource

	const sections: ContextSection[] = []
	if (mcp.length > 0) {
		sections.push({
			title: 'MCP tools',
			hint: '/mcp',
			groups: [
				{
					items: [...mcp]
						.sort((a, b) => b.tokens - a.tokens)
						.map((tool) => ({
							label: mcpLabel(tool.name, tool.server ?? ''),
							value: `${formatTokens(tool.tokens)} tokens`,
						})),
				},
			],
		})
	}
	if (agentSizes.length > 0) {
		sections.push({
			title: 'Custom agents',
			hint: '.namzu/agents/',
			groups: groupBySource(
				agentSizes,
				(entry) => entry.agent.source,
				(entry) => ({
					label: entry.agent.name,
					value: `${formatTokens(entry.tokens)} tokens`,
					tokens: entry.tokens,
				}),
			),
		})
	}
	if (memory.length > 0) {
		sections.push({
			title: 'Memory files',
			hint: '/memory',
			groups: [
				{
					items: memory.map((file) => ({
						label: file.label,
						value: `${formatTokens(file.tokens)} tokens`,
					})),
				},
			],
		})
	}
	if (skillSizes.length > 0) {
		sections.push({
			title: 'Skills',
			hint: '/skills',
			groups: groupBySource(
				skillSizes,
				(entry) => entry.skill.source,
				(entry) => ({
					label: entry.skill.name,
					value: formatSkillTokens(entry.tokens),
					tokens: entry.tokens,
				}),
			),
		})
	}

	return buildContextView({
		breakdown,
		windowSource: source,
		...(sources.context.windowRequested !== undefined
			? { windowRequested: sources.context.windowRequested }
			: {}),
		autoCompact: sources.autoCompact,
		...(sources.cacheLifetime ? { cacheLifetime: sources.cacheLifetime } : {}),
		approximate: sources.sizeOutOfDate === true || !sources.context.measured,
		...(sources.model ? { model: sources.model } : {}),
		terminalColumns: sources.terminalColumns,
		sections,
		memoryFiles: memory,
	})
}

export interface ContextRowInput {
	readonly usage: SlashContext['usage']
	readonly compaction: SlashContext['compaction']
	readonly details: boolean
	/** A compaction or a summary has rewritten the history since the last reply's size was reported. */
	readonly sizeOutOfDate?: boolean
	readonly session: AgentSession | null | undefined
	readonly messages: readonly Message[]
	readonly cwd: string
	readonly columns: number
	readonly model?: string | undefined
	/** The provider answering now; the cache lifetime is shown only where it can be chosen. */
	readonly providerId?: string | null | undefined
	readonly mcp: ReturnType<SlashContext['mcp']>
	readonly skillsConfig?: SkillsConfig | undefined
}

/**
 * What `/context` writes: the view when the kernel has reported a window, and
 * the one-line answer ("no size yet") before the first reply.
 */
export async function buildContextRow(input: ContextRowInput): Promise<ContextView | string> {
	const context = input.usage?.context
	if (!context || context.windowTokens <= 0) return renderContext(input.usage, input.compaction)
	const { agents, skills } = await discoverContextLists({
		cwd: input.cwd,
		skillsConfig: input.skillsConfig,
	})
	const inventory = input.session?.contextInventory?.()
	const view = await collectContextView({
		context,
		...(input.sizeOutOfDate ? { sizeOutOfDate: true } : {}),
		terminalColumns: input.columns,
		...(input.model ? { model: input.model } : {}),
		autoCompact: true,
		...(providerOffersCacheLifetime(input.providerId)
			? { cacheLifetime: describeCacheLifetime(promptCacheTtl()) }
			: {}),
		...(inventory?.systemPrompt ? { systemPrompt: inventory.systemPrompt } : {}),
		tools: inventory?.tools ?? [],
		...(inventory?.deferredTools ? { deferredTools: inventory.deferredTools } : {}),
		messages: input.messages,
		instructionFiles: input.session?.instructionFiles ?? [],
		mcpInstructions: (input.mcp?.connected ?? []).flatMap((server) =>
			server.instructions ? [server.instructions] : [],
		),
		skills,
		agents,
		displayPath: (path) => displayPath(path, input.cwd),
	})
	const notes = contextCleanupLines(input.compaction, input.details)
	if (!input.details) notes.push('/context details for how it was summarised.')
	return withContextNotes(view, notes)
}
