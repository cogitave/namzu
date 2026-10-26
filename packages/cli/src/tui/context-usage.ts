/**
 * Gathers what `/context` needs from a live session and hands it to the
 * arithmetic and the view.
 *
 * The sizes are estimates by characters, the same way the kernel estimates a
 * request it has not yet sent; the measured total from the provider, when
 * there is one, replaces the guess for the conversation as a whole.
 */

import { readFile } from 'node:fs/promises'

import { type AgentFileDefinition, analyzeContextUsage, estimateTextTokens } from '@namzu/sdk'
import type { Message } from '@namzu/sdk'

import type { SkillsConfig } from '../config/schema.js'
import { discoverAgentDefinitions } from '../integrations/subagents/definitions.js'
import { type SkillInfo, discoverSkills } from '../skills/store.js'
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

export interface ContextSources {
	/** The latest report from the kernel; the view needs its window. */
	readonly context: {
		readonly tokens: number
		readonly windowTokens: number
		readonly measured: boolean
		readonly windowAssumed: boolean
		readonly windowSource?: 'config' | 'provider' | 'model-table' | 'default'
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
	readonly systemPrompt?: string
	readonly tools: readonly { name: string; tokens: number; server?: string }[]
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
	const read = sources.readText ?? ((path: string) => readFile(path, 'utf8'))
	const builtIn = sources.tools.filter((tool) => tool.server === undefined)
	const mcp = sources.tools.filter((tool) => tool.server !== undefined)

	const memory: { label: string; tokens: number }[] = []
	for (const path of sources.instructionFiles) {
		let text = ''
		try {
			text = await read(path)
		} catch {
			// A file that vanished since it was loaded costs nothing now.
		}
		memory.push({ label: sources.displayPath(path), tokens: estimateTextTokens(text) })
	}

	const listedSkills = sources.skills.filter(
		(skill) => !skill.problem && !skill.disabled && skill.invocation !== 'operator',
	)
	const skillSizes = listedSkills.map((skill) => ({
		skill,
		tokens: estimateTextTokens(`${skill.name}: ${skill.description}`),
	}))
	const agentSizes = sources.agents.map((agent) => ({
		agent,
		tokens: estimateTextTokens(`${agent.name} ${agent.description}`),
	}))
	const sum = (values: readonly { tokens: number }[]) => values.reduce((n, v) => n + v.tokens, 0)

	const source =
		sources.context.windowSource === 'config'
			? 'config'
			: sources.context.windowSource === 'default'
				? 'default'
				: 'auto'
	const breakdown = analyzeContextUsage({
		windowTokens: sources.context.windowTokens,
		windowSource: source,
		autoCompact: sources.autoCompact,
		...(sources.sizeOutOfDate ? {} : { contextTokens: sources.context.tokens }),
		systemPromptTokens: sources.systemPrompt ? estimateTextTokens(sources.systemPrompt) : 0,
		systemToolTokens: sum(builtIn),
		mcpToolTokens: sum(mcp),
		mcpInstructionTokens: sources.mcpInstructions.reduce(
			(n, text) => n + estimateTextTokens(text),
			0,
		),
		agentTokens: sum(agentSizes),
		memoryTokens: sum(memory),
		skillTokens: sum(skillSizes),
		messages: sources.messages,
	})

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
		autoCompact: sources.autoCompact,
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
	let agents: readonly AgentFileDefinition[] = []
	try {
		agents = (await discoverAgentDefinitions({ cwd: input.cwd })).definitions
	} catch {
		// An unreadable agents folder leaves the list out; the rest still answers.
	}
	let skills: readonly SkillInfo[] = []
	try {
		skills = discoverSkills({
			cwd: input.cwd,
			...(input.skillsConfig ? { config: input.skillsConfig } : {}),
		})
	} catch {
		// Same: skills are one list among several.
	}
	const inventory = input.session?.contextInventory?.()
	const view = await collectContextView({
		context,
		...(input.sizeOutOfDate ? { sizeOutOfDate: true } : {}),
		terminalColumns: input.columns,
		...(input.model ? { model: input.model } : {}),
		autoCompact: true,
		...(inventory?.systemPrompt ? { systemPrompt: inventory.systemPrompt } : {}),
		tools: inventory?.tools ?? [],
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
