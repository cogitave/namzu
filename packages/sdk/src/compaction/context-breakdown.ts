/**
 * Where the context window goes: the arithmetic behind a `/context` view.
 *
 * Pure. A host hands in what it knows (sizes of the system prompt, the tool
 * catalogue, instruction files, skills, agents, and the conversation) and gets
 * the categories back in the order they are drawn, with the free room and the
 * compaction buffer accounted for. Nothing here reads a provider or a file.
 *
 * The conversation's own share is never counted separately: it is whatever the
 * measured prompt size is once the fixed parts are taken out, so the categories
 * always add up to the figure the provider reported. A figure the kernel only
 * estimated covers less than a provider's, and is read that way.
 */

import { CHARS_PER_TOKEN } from '../constants/limits.js'
import { type Message, isTurnContextEntry } from '../types/message/index.js'
import type { LLMToolSchema } from '../types/tool/index.js'
import { TRIGGER_BUFFER_TOKENS, TRIGGER_OUTPUT_RESERVE_CAP_TOKENS } from './context-window.js'
import { estimateMessageTokens, estimateTextTokens } from './token-estimate.js'

/** The categories, in the order they are laid out. */
export const CONTEXT_CATEGORY_ORDER = [
	'system-prompt',
	'system-tools',
	'mcp-tools',
	'mcp-instructions',
	'agents',
	'memory',
	'skills',
	'messages',
] as const

/**
 * Tool definitions that are not sent yet (they load only when the model asks
 * for them) are sized as `deferred`. They are never counted as used.
 */
export const DEFERRED_CATEGORY_ORDER = ['deferred-tools', 'deferred-mcp-tools'] as const

export type ContextCategoryId =
	| (typeof CONTEXT_CATEGORY_ORDER)[number]
	| (typeof DEFERRED_CATEGORY_ORDER)[number]
	| 'buffer'
	| 'free'
export type ContextCategoryKind = 'used' | 'deferred' | 'free' | 'buffer'

export interface ContextCategory {
	readonly id: ContextCategoryId
	readonly name: string
	readonly tokens: number
	readonly kind: ContextCategoryKind
}

const DEFERRED_NAMES: Record<(typeof DEFERRED_CATEGORY_ORDER)[number], string> = {
	'deferred-tools': 'System tools (deferred)',
	'deferred-mcp-tools': 'MCP tools (deferred)',
}

const NAMES: Record<(typeof CONTEXT_CATEGORY_ORDER)[number], string> = {
	'system-prompt': 'System prompt',
	'system-tools': 'System tools',
	'mcp-tools': 'MCP tools',
	'mcp-instructions': 'MCP server instructions',
	agents: 'Custom agents',
	memory: 'Memory files',
	skills: 'Skills',
	messages: 'Messages',
}

export interface ContextUsageInput {
	readonly windowTokens: number
	/**
	 * `auto` when the window is what the provider or model table declares;
	 * `config` or `default` when it was overridden or guessed. The compaction
	 * buffer is drawn for every source whenever the session summarises on its
	 * own, so this no longer changes the numbers; it stays so a host can say
	 * where the window came from.
	 */
	readonly windowSource: 'auto' | 'config' | 'default'
	/** What the model may write in one reply; absent reserves the full cap. */
	readonly maxOutputTokens?: number
	/** Whether the session summarises on its own. */
	readonly autoCompact: boolean
	/**
	 * The size of everything being sent: counted by the provider, or estimated.
	 * Absent, the conversation is estimated from `messages`.
	 */
	readonly contextTokens?: number
	/**
	 * Who counted `contextTokens`. A provider counts the whole request. The
	 * kernel's own estimate covers only the messages and the tool catalogue, so
	 * the system prompt, instruction files, skills and agents are added on top
	 * of it instead of being taken out of it. Absent is read as `provider`.
	 */
	readonly measuredBy?: 'provider' | 'estimate'
	readonly systemPromptTokens?: number
	/** Tokens of the built-in tool definitions. */
	readonly systemToolTokens?: number
	readonly mcpToolTokens?: number
	readonly mcpInstructionTokens?: number
	readonly agentTokens?: number
	readonly memoryTokens?: number
	readonly skillTokens?: number
	/** Tokens of built-in tool definitions that load only when needed; not counted as used. */
	readonly deferredToolTokens?: number
	/** Tokens of tool-server tool definitions that load only when needed; not counted as used. */
	readonly deferredMcpToolTokens?: number
	/** The conversation, for the estimate and for the per-tool breakdown. */
	readonly messages?: readonly Message[]
}

export interface ContextMessageBreakdown {
	/** Tokens of the calls the model wrote, by tool name. */
	readonly toolCallsByType: Readonly<Record<string, number>>
	/** Tokens of the results that came back, by the name of the tool called. */
	readonly toolResultsByType: Readonly<Record<string, number>>
	readonly assistantTokens: number
	readonly userTokens: number
}

export interface ContextBreakdown {
	readonly categories: readonly ContextCategory[]
	readonly windowTokens: number
	/** Everything in use, which can exceed the window. */
	readonly totalTokens: number
	/** Whole percent of the window in use. */
	readonly percentage: number
	/** The compaction buffer, 0 when it is not drawn. */
	readonly bufferTokens: number
	/** Whether the session summarises on its own; names the buffer. */
	readonly autoCompact: boolean
	/** How far past the window the context is; 0 while it fits. */
	readonly overflowTokens: number
	readonly messageBreakdown: ContextMessageBreakdown
}

/** Per-tool size of a catalogue already rendered the way it is sent. */
export function describeToolCatalogTokens(
	tools: readonly LLMToolSchema[],
): { name: string; tokens: number }[] {
	return tools.map((tool) => {
		let length = 0
		try {
			length = JSON.stringify(tool).length
		} catch {
			// A tool that cannot render is the model call's problem to report.
		}
		return { name: tool.function.name, tokens: Math.ceil(length / CHARS_PER_TOKEN) }
	})
}

function nonNegative(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function bufferFor(input: ContextUsageInput): number {
	if (input.autoCompact) {
		// Drawn whenever the session summarises on its own, for every window
		// source: it is the room the trigger keeps for the next reply.
		const reserve = Math.min(
			input.maxOutputTokens !== undefined && input.maxOutputTokens > 0
				? input.maxOutputTokens
				: TRIGGER_OUTPUT_RESERVE_CAP_TOKENS,
			TRIGGER_OUTPUT_RESERVE_CAP_TOKENS,
		)
		return reserve + TRIGGER_BUFFER_TOKENS
	}
	return COMPACT_BUFFER_TOKENS
}

/** Room kept for a manual compaction when nothing summarises on its own. */
export const COMPACT_BUFFER_TOKENS = 3_000

function tokensOfContent(message: Message): number {
	return estimateMessageTokens(message)
}

function breakdownMessages(messages: readonly Message[]): ContextMessageBreakdown {
	const toolCallsByType: Record<string, number> = {}
	const toolResultsByType: Record<string, number> = {}
	const nameOfCall = new Map<string, string>()
	let assistantTokens = 0
	let userTokens = 0
	for (const message of messages) {
		if (message.role === 'assistant') {
			let calls = 0
			for (const call of message.toolCalls ?? []) {
				nameOfCall.set(call.id, call.function.name)
				const tokens = estimateTextTokens(call.function.name + call.function.arguments)
				toolCallsByType[call.function.name] = (toolCallsByType[call.function.name] ?? 0) + tokens
				calls += tokens
			}
			assistantTokens += Math.max(0, tokensOfContent(message) - calls)
		} else if (message.role === 'tool') {
			const name = nameOfCall.get(message.toolCallId) ?? 'unknown'
			toolResultsByType[name] = (toolResultsByType[name] ?? 0) + tokensOfContent(message)
		} else if (message.role === 'user') {
			// Recorded context is what the host recalled for the model, not
			// something the operator said, so it is counted under memory.
			if (isTurnContextEntry(message)) continue
			userTokens += tokensOfContent(message)
		}
	}
	return { toolCallsByType, toolResultsByType, assistantTokens, userTokens }
}

/** Split a window into the parts that fill it. */
export function analyzeContextUsage(input: ContextUsageInput): ContextBreakdown {
	const windowTokens = Math.max(0, Math.round(input.windowTokens))
	const recorded = (input.messages ?? []).filter(isTurnContextEntry)
	const recordedTokens = recorded.reduce((sum, message) => sum + tokensOfContent(message), 0)
	const fixed: Record<(typeof CONTEXT_CATEGORY_ORDER)[number], number> = {
		'system-prompt': nonNegative(input.systemPromptTokens),
		'system-tools': nonNegative(input.systemToolTokens),
		'mcp-tools': nonNegative(input.mcpToolTokens),
		'mcp-instructions': nonNegative(input.mcpInstructionTokens),
		agents: nonNegative(input.agentTokens),
		memory: nonNegative(input.memoryTokens) + recordedTokens,
		skills: nonNegative(input.skillTokens),
		messages: 0,
	}
	const fixedTotal = Object.values(fixed).reduce((sum, tokens) => sum + tokens, 0)
	// The kernel's estimate counts the messages (recorded context included) and
	// the tool catalogue, and nothing else; the rest sits on top of it.
	const estimated = input.measuredBy === 'estimate'
	const inEstimate = estimated
		? fixed['system-tools'] + fixed['mcp-tools'] + recordedTokens
		: fixedTotal
	const outsideEstimate = fixedTotal - inEstimate
	const messages = input.messages ?? []
	const bufferTokens = Math.min(bufferFor(input), windowTokens)

	// The conversation is what the measured size leaves once the fixed parts
	// are taken out; without a measurement it is counted from the messages.
	const measured = nonNegative(input.contextTokens)
	const rawMessages =
		measured > 0
			? Math.max(0, measured - inEstimate)
			: messages.reduce(
					(sum, message) => (isTurnContextEntry(message) ? sum : sum + tokensOfContent(message)),
					0,
				)
	fixed.messages = Math.min(rawMessages, Math.max(0, windowTokens - fixedTotal - bufferTokens))

	const totalTokens =
		measured > 0 ? Math.max(measured + outsideEstimate, fixedTotal) : fixedTotal + rawMessages
	const used = fixedTotal + fixed.messages
	const categories: ContextCategory[] = []
	for (const id of CONTEXT_CATEGORY_ORDER) {
		if (fixed[id] > 0) categories.push({ id, name: NAMES[id], tokens: fixed[id], kind: 'used' })
	}
	for (const id of DEFERRED_CATEGORY_ORDER) {
		const tokens = nonNegative(
			id === 'deferred-tools' ? input.deferredToolTokens : input.deferredMcpToolTokens,
		)
		if (tokens > 0) categories.push({ id, name: DEFERRED_NAMES[id], tokens, kind: 'deferred' })
	}
	const free = Math.max(0, windowTokens - used - bufferTokens)
	if (bufferTokens > 0) {
		categories.push({
			id: 'buffer',
			name: input.autoCompact ? 'Autocompact buffer' : 'Compact buffer',
			tokens: bufferTokens,
			kind: 'buffer',
		})
	}
	categories.push({ id: 'free', name: 'Free space', tokens: free, kind: 'free' })

	return {
		categories,
		windowTokens,
		totalTokens,
		percentage: windowTokens > 0 ? Math.round((totalTokens / windowTokens) * 100) : 0,
		bufferTokens,
		autoCompact: input.autoCompact,
		overflowTokens: Math.max(0, totalTokens - windowTokens),
		messageBreakdown: breakdownMessages(messages),
	}
}
