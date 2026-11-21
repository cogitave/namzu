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
 *
 * What a call line does carry, once the call has a result, is how it ended:
 * ran, failed, was interrupted, or was refused and by whom. That comes from
 * the fields the kernel wrote on the result (`isError`, `outcome`), never from
 * the result's text, so a tool cannot claim an ending it did not have. It is
 * what lets the classifier see a call that comes back after a person's no or a
 * block as a second try.
 */

import type { ToolManager } from '../../../toolsets/manager.js'
import type { Message, ToolMessage } from '../../../types/message/index.js'
import { PASTED_MARKER, typedTextOf } from '../pasted-frames.js'

/** How an earlier call ended, in the words the classifier reads. */
export type TranscriptCallOutcome =
	| 'ok'
	| 'error'
	| 'interrupted'
	| 'rejected by the person'
	| 'refused by the mode the session was in'
	| 'blocked by permissions'
	| 'blocked by auto mode'
	| 'auto mode unavailable'

/** One entry of the projected transcript, before it is rendered. */
export type TranscriptEntry =
	| { readonly kind: 'user'; readonly text: string }
	| { readonly kind: 'assistant'; readonly text: string }
	| {
			readonly kind: 'tool'
			readonly name: string
			readonly input: string
			/** How the call ended. Absent while it has no result yet. */
			readonly outcome?: TranscriptCallOutcome
	  }

export interface ProjectionOptions {
	/** Where tool definitions are looked up for `classifierInput`. Absent: every call is compact JSON. */
	readonly tools?: Pick<ToolManager, 'get'>
	/** Tool-call ids to leave out, because they are the action under review. */
	readonly excludeCallIds?: ReadonlySet<string>
	/** The most characters one entry keeps. Default 2000. */
	readonly maxEntryChars?: number
}

const DEFAULT_ENTRY_CHARS = 2_000

/**
 * A file a host inlined into the person's message (`@path`). Its content is
 * whatever the file says, not the person's words, so a second guard removes it
 * even from a message that carries no provenance; the host's own marking
 * (`source`) is the first.
 */
const INLINED_FILE_BLOCK = /<file\b[^>]*>[\s\S]*?<\/file>/gi

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

/** The line shown for a call, and whether it had to be cut to fit. */
export interface ProjectedCall {
	readonly text: string
	/** The call is longer than the limit: `text` is a prefix and the rest was never shown. */
	readonly truncated: boolean
}

/**
 * The line shown for a call: the tool's own account of it, or the input as
 * compact JSON when the tool has none or its account is empty or throws.
 * `truncated` is true when what the tool (or the JSON) said was longer than
 * `limit`, so a caller judging THIS call can refuse to judge a prefix of it.
 */
export function projectAction(
	name: string,
	input: unknown,
	tools: Pick<ToolManager, 'get'> | undefined,
	limit: number = DEFAULT_ENTRY_CHARS,
): ProjectedCall {
	const tool = tools?.get(name) ?? tools?.get(name.toLowerCase())
	let text: string | undefined
	if (tool?.classifierInput !== undefined) {
		try {
			const described = tool.classifierInput(input as never)
			if (typeof described === 'string' && described.trim() !== '') text = described
		} catch {
			// A tool that cannot describe its own call is shown as its input.
		}
	}
	if (text === undefined) {
		try {
			text = JSON.stringify(input) ?? ''
		} catch {
			text = String(input)
		}
	}
	return { text: clip(text, limit), truncated: text.length > limit }
}

/** {@link projectAction}'s text, for a line of history where a cut is only context. */
export function projectCall(
	name: string,
	input: unknown,
	tools: Pick<ToolManager, 'get'> | undefined,
	limit: number = DEFAULT_ENTRY_CHARS,
): string {
	return projectAction(name, input, tools, limit).text
}

/** How the call a result answers ended, from the fields the kernel wrote on it. */
export function callOutcome(result: ToolMessage): TranscriptCallOutcome {
	switch (result.outcome) {
		case 'interrupted':
			return 'interrupted'
		case 'rejected':
			return 'rejected by the person'
		case 'refused_by_mode':
			return 'refused by the mode the session was in'
		case 'blocked_by_permissions':
			return 'blocked by permissions'
		case 'blocked_by_auto_mode':
			return 'blocked by auto mode'
		case 'auto_mode_unavailable':
			return 'auto mode unavailable'
		case undefined:
			return result.isError === true ? 'error' : 'ok'
	}
}

/** The conversation as the classifier sees it, oldest first. */
export function projectTranscript(
	messages: readonly Message[],
	options: ProjectionOptions = {},
): TranscriptEntry[] {
	const limit = options.maxEntryChars ?? DEFAULT_ENTRY_CHARS
	// The result of each call, by id, so the call's line can say how it ended.
	// Only the result's own fields are read, never its content.
	const results = new Map<string, ToolMessage>()
	for (const message of messages) {
		if (message.role === 'tool') results.set(message.toolCallId, message)
	}
	const entries: TranscriptEntry[] = []
	for (const message of messages) {
		if (message.role === 'user') {
			// A user-role message the kernel wrote (instructions, reminders, a goal
			// round) is not the person speaking.
			if (message.source !== undefined) continue
			if (typeof message.content === 'string') {
				// Text the person pasted is material, not their authorisation: unless
				// the paste is the whole message, only what they typed is read.
				const typed = typedTextOf(message, PASTED_MARKER)
				const own = typed.replaceAll(PASTED_MARKER, ' ').trim() === '' ? message.content : typed
				const spoken = own.replace(INLINED_FILE_BLOCK, ' ').trim()
				if (spoken !== '') entries.push({ kind: 'user', text: clip(spoken, limit) })
			}
			continue
		}
		if (message.role !== 'assistant') continue
		if (typeof message.content === 'string' && message.content.trim() !== '') {
			entries.push({ kind: 'assistant', text: clip(message.content, limit) })
		}
		for (const call of message.toolCalls ?? []) {
			if (options.excludeCallIds?.has(call.id)) continue
			const result = results.get(call.id)
			entries.push({
				kind: 'tool',
				name: call.function.name,
				input: projectCall(
					call.function.name,
					parseArguments(call.function.arguments),
					options.tools,
					limit,
				),
				...(result ? { outcome: callOutcome(result) } : {}),
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
		entry.kind === 'tool'
			? {
					tool: entry.name,
					input: entry.input,
					...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
				}
			: { [entry.kind]: entry.text }
	return JSON.stringify(body).replaceAll('<', '\\u003c')
}

/** The size of a rendered transcript, for the decision whether it is too long. */
export function renderedLength(lines: readonly string[]): number {
	let total = 0
	for (const line of lines) total += line.length + 1
	return total
}
