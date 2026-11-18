/**
 * Gathers what a "where did my context go" view needs from a live session and
 * runs the arithmetic over it. The terminal's `/context` and the desktop's
 * context panel both call this, so the two always show the same sizes.
 *
 * The sizes are estimates by characters, the same way the kernel estimates a
 * request it has not yet sent; the measured total from the provider, when
 * there is one, replaces the guess for the conversation as a whole.
 */

import { readFile } from 'node:fs/promises'

import {
	type AgentFileDefinition,
	type ContextBreakdown,
	type Message,
	analyzeContextUsage,
	estimateTextTokens,
} from '@namzu/sdk'

import type { SkillsConfig } from '../../config/schema.js'
import { type SkillInfo, discoverSkills } from '../../skills/store.js'
import { discoverAgentDefinitions } from '../subagents/definitions.js'

export interface SizedTool {
	readonly name: string
	readonly tokens: number
	/** The connected tool server it came from; absent for a built-in tool. */
	readonly server?: string
}

export interface ContextGatherSources {
	/** The latest report from the kernel. */
	readonly context: {
		readonly tokens: number
		readonly windowTokens: number
		/** Whether the provider counted `tokens`; false when the kernel estimated it. */
		readonly measured: boolean
		readonly windowSource?: 'config' | 'provider' | 'model-table' | 'default'
	}
	/**
	 * The conversation was rewritten (compacted, summarised in part) since that
	 * report, so its size is out of date. The conversation's share is then
	 * estimated from `messages`.
	 */
	readonly sizeOutOfDate?: boolean
	readonly autoCompact: boolean
	/** What the model may write in one reply, when known. */
	readonly maxOutputTokens?: number
	readonly systemPrompt?: string
	/** Tools in the request now. */
	readonly tools: readonly SizedTool[]
	/** Tools that load only when needed. */
	readonly deferredTools?: readonly SizedTool[]
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

export interface ContextGathering {
	readonly breakdown: ContextBreakdown
	readonly windowSource: 'auto' | 'config' | 'default'
	readonly builtIn: readonly SizedTool[]
	readonly mcp: readonly SizedTool[]
	readonly deferredBuiltIn: readonly SizedTool[]
	readonly deferredMcp: readonly SizedTool[]
	readonly memory: readonly { label: string; tokens: number }[]
	readonly skillSizes: readonly { skill: SkillInfo; tokens: number }[]
	readonly agentSizes: readonly { agent: AgentFileDefinition; tokens: number }[]
}

const sum = (values: readonly { tokens: number }[]) => values.reduce((n, v) => n + v.tokens, 0)

/** The skills and agents this folder offers; an unreadable folder leaves its list out. */
export async function discoverContextLists(input: {
	readonly cwd: string
	readonly skillsConfig?: SkillsConfig | undefined
}): Promise<{ agents: readonly AgentFileDefinition[]; skills: readonly SkillInfo[] }> {
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
	return { agents, skills }
}

export async function gatherContext(sources: ContextGatherSources): Promise<ContextGathering> {
	const read = sources.readText ?? ((path: string) => readFile(path, 'utf8'))
	const builtIn = sources.tools.filter((tool) => tool.server === undefined)
	const mcp = sources.tools.filter((tool) => tool.server !== undefined)
	const deferredBuiltIn = (sources.deferredTools ?? []).filter((tool) => tool.server === undefined)
	const deferredMcp = (sources.deferredTools ?? []).filter((tool) => tool.server !== undefined)

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

	const windowSource =
		sources.context.windowSource === 'config'
			? 'config'
			: sources.context.windowSource === 'default'
				? 'default'
				: 'auto'
	const breakdown = analyzeContextUsage({
		windowTokens: sources.context.windowTokens,
		windowSource,
		autoCompact: sources.autoCompact,
		...(sources.maxOutputTokens !== undefined ? { maxOutputTokens: sources.maxOutputTokens } : {}),
		...(sources.sizeOutOfDate
			? {}
			: {
					contextTokens: sources.context.tokens,
					measuredBy: sources.context.measured ? ('provider' as const) : ('estimate' as const),
				}),
		systemPromptTokens: sources.systemPrompt ? estimateTextTokens(sources.systemPrompt) : 0,
		systemToolTokens: sum(builtIn),
		mcpToolTokens: sum(mcp),
		deferredToolTokens: sum(deferredBuiltIn),
		deferredMcpToolTokens: sum(deferredMcp),
		mcpInstructionTokens: sources.mcpInstructions.reduce(
			(n, text) => n + estimateTextTokens(text),
			0,
		),
		agentTokens: sum(agentSizes),
		memoryTokens: sum(memory),
		skillTokens: sum(skillSizes),
		messages: sources.messages,
	})
	return {
		breakdown,
		windowSource,
		builtIn,
		mcp,
		deferredBuiltIn,
		deferredMcp,
		memory,
		skillSizes,
		agentSizes,
	}
}
