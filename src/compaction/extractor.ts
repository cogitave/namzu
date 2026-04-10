import type { CompactionConfig } from '../config/runtime.js'
import { EDIT_TOOLS, READ_TOOLS, SEARCH_TOOLS, SHELL_TOOLS } from '../constants/compaction/index.js'
import type { WorkingStateManager } from './manager.js'

function tryParseJson(raw: string): Record<string, unknown> | null {
	try {
		return JSON.parse(raw) as Record<string, unknown>
	} catch {
		return null
	}
}

function extractFilePath(args: Record<string, unknown>): string | null {
	if (typeof args.path === 'string') return args.path
	if (typeof args.file_path === 'string') return args.file_path
	if (typeof args.filePath === 'string') return args.filePath
	return null
}

function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
}

function isSubstantive(sentence: string): boolean {
	const fillerPatterns = [
		/^(ok|okay|sure|alright|got it|understood|i see|let me|i'll|i will|now i|here)/i,
		/^(great|perfect|excellent|good|nice|cool|right|yes|no|thanks)/i,
		/^(let's|we can|we should|i can|i should)/i,
	]
	return !fillerPatterns.some((pattern) => pattern.test(sentence))
}

function truncateResult(result: string, maxLen: number): string {
	if (result.length <= maxLen) return result
	return `${result.slice(0, maxLen)}...`
}

export function extractFromToolCall(
	manager: WorkingStateManager,
	toolName: string,
	args: string,
): void {
	const parsed = tryParseJson(args)
	if (!parsed) return

	const filePath = extractFilePath(parsed)

	if (READ_TOOLS.has(toolName) && filePath) {
		manager.trackFile(filePath, { type: 'read', summary: 'read' })
	} else if (EDIT_TOOLS.has(toolName) && filePath) {
		const detail =
			typeof parsed.content === 'string' ? truncateResult(parsed.content, 100) : 'modified'
		manager.trackFile(filePath, { type: 'edit', detail })
	} else if (SEARCH_TOOLS.has(toolName)) {
		const pattern = typeof parsed.pattern === 'string' ? parsed.pattern : ''
		const path = typeof parsed.path === 'string' ? parsed.path : ''
		if (pattern || path) {
			manager.addDiscovery(`Searched: ${pattern}${path ? ` in ${path}` : ''}`)
		}
	} else if (SHELL_TOOLS.has(toolName)) {
		const command = typeof parsed.command === 'string' ? parsed.command : ''
		if (command) {
			manager.addToolResult({
				tool: toolName,
				summary: `Ran: ${truncateResult(command, 120)}`,
				timestamp: Date.now(),
			})
		}
	}
}

export function extractFromToolResult(
	manager: WorkingStateManager,
	toolName: string,
	result: string,
	isError: boolean,
): void {
	if (isError) {
		manager.addFailure(`${toolName}: ${truncateResult(result, 200)}`)
		return
	}

	if (READ_TOOLS.has(toolName)) {
		const lineCount = result.split('\n').length
		manager.addToolResult({
			tool: toolName,
			summary: `${lineCount} lines`,
			timestamp: Date.now(),
		})
	} else if (SEARCH_TOOLS.has(toolName)) {
		const matches = result.split('\n').filter((l) => l.trim().length > 0)
		manager.addToolResult({
			tool: toolName,
			summary: `${matches.length} results`,
			timestamp: Date.now(),
		})
	} else if (EDIT_TOOLS.has(toolName)) {
		manager.addToolResult({
			tool: toolName,
			summary: truncateResult(result, 100),
			timestamp: Date.now(),
		})
	} else if (SHELL_TOOLS.has(toolName)) {
		manager.addToolResult({
			tool: toolName,
			summary: truncateResult(result, 150),
			timestamp: Date.now(),
		})
	} else {
		manager.addToolResult({
			tool: toolName,
			summary: truncateResult(result, 120),
			timestamp: Date.now(),
		})
	}
}

export function extractFromUserMessage(
	manager: WorkingStateManager,
	content: string,
	isFirst: boolean,
): void {
	if (!content.trim()) return

	if (isFirst) {
		manager.setTask(content.trim())
	} else {
		manager.addUserRequirement(content.trim())
	}
}

export function extractFromAssistantMessage(
	manager: WorkingStateManager,
	content: string,
	config: CompactionConfig,
): void {
	if (!content || !content.trim()) return

	const sentences = splitSentences(content)
	const substantive = sentences.filter(isSubstantive)
	const selected = substantive.slice(0, config.maxSentencesPerTurn)

	for (const sentence of selected) {
		manager.addAssistantNote(sentence)
	}
}
