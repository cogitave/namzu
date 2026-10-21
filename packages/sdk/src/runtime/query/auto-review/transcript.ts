/**
 * What the auto-review classifier is shown of the conversation.
 *
 * Three kinds of entry and no more: the person's own messages, the agent's
 * prose, and one short line per tool call, written by the tool itself
 * (`ToolDefinition.classifierInput`). Tool RESULTS are never included. A result
 * is whatever a command printed or a page said, which is exactly where an
 * injected instruction would sit, and a classifier that read it could be
 * argued out of a block by the text it is supposed to be guarding against.
 * Kernel-written context (project instructions, reminders, compaction summaries)
 * is left out too: it was not written by the person.
 */

import type { ToolManager } from '../../../toolsets/manager.js'
import type { Message } from '../../../types/message/index.js'

/** One entry of the projected transcript, before it is rendered. */
export type TranscriptEntry =
	| { readonly kind: 'user'; readonly text: string }
	| { readonly kind: 'assistant'; readonly text: string }
	| { readonly kind: 'tool'; readonly name: string; readonly input: string }

export interface ProjectionOptions {
	/** Where tool definitions are looked up for `classifierInput`. Absent: every call is compact JSON. */
	readonly tools?: Pick<ToolManager, 'get'>
	/** Tool-call ids to leave out, because they are the action under review. */
	readonly excludeCallIds?: ReadonlySet<string>
	/** The most characters one entry keeps. Default 2000. */
	readonly maxEntryChars?: number
}

const DEFAULT_ENTRY_CHARS = 2_000

function clip(text: string, limit: number): string {
	return text.length <= limit
		? text
		: `${text.slice(0, limit)}... [${text.length - limit} more characters]`
}

function parseArguments(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch {
		return raw
	}
}

/**
 * The line shown for a call: the tool's own account of it, or the input as
 * compact JSON when the tool has none or its account is empty or throws.
 */
export function projectCall(
	name: string,
	input: unknown,
	tools: Pick<ToolManager, 'get'> | undefined,
	limit: number = DEFAULT_ENTRY_CHARS,
): string {
	const tool = tools?.get(name) ?? tools?.get(name.toLowerCase())
	if (tool?.classifierInput !== undefined) {
		try {
			const text = tool.classifierInput(input as never)
			if (typeof text === 'string' && text.trim() !== '') return clip(text, limit)
		} catch {
			// A tool that cannot describe its own call is shown as its input.
		}
	}
	let json: string
	try {
		json = JSON.stringify(input) ?? ''
	} catch {
		json = String(input)
	}
	return clip(json, limit)
}

/** The conversation as the classifier sees it, oldest first. */
export function projectTranscript(
	messages: readonly Message[],
	options: ProjectionOptions = {},
): TranscriptEntry[] {
	const limit = options.maxEntryChars ?? DEFAULT_ENTRY_CHARS
	const entries: TranscriptEntry[] = []
	for (const message of messages) {
		if (message.role === 'user') {
			// A user-role message the kernel wrote (instructions, reminders, a goal
			// round) is not the person speaking.
			if (message.source !== undefined) continue
			if (typeof message.content === 'string' && message.content.trim() !== '') {
				entries.push({ kind: 'user', text: clip(message.content, limit) })
			}
			continue
		}
		if (message.role !== 'assistant') continue
		if (typeof message.content === 'string' && message.content.trim() !== '') {
			entries.push({ kind: 'assistant', text: clip(message.content, limit) })
		}
		for (const call of message.toolCalls ?? []) {
			if (options.excludeCallIds?.has(call.id)) continue
			entries.push({
				kind: 'tool',
				name: call.function.name,
				input: projectCall(
					call.function.name,
					parseArguments(call.function.arguments),
					options.tools,
					limit,
				),
			})
		}
	}
	return entries
}

/**
 * One entry as a line of JSON, with `<` escaped so that nothing in it can
 * close or open an element of the prompt around it.
 */
export function renderEntry(entry: TranscriptEntry): string {
	const body =
		entry.kind === 'tool' ? { tool: entry.name, input: entry.input } : { [entry.kind]: entry.text }
	return JSON.stringify(body).replaceAll('<', '\\u003c')
}

/** The size of a rendered transcript, for the decision whether it is too long. */
export function renderedLength(lines: readonly string[]): number {
	let total = 0
	for (const line of lines) total += line.length + 1
	return total
}
