import type { Message } from '@namzu/sdk'

import { frameReminder, isOperatorTurn, reminderKindOf } from './frame.js'

/**
 * The memory nudge: a quiet reminder that a short lesson about this machine or
 * project is worth saving with the memory tool. It speaks in two cases only:
 *
 * - the same environment failure came back twice (exit 127 or 126; a
 *   program not found counts as exit 127; an ordinary exit 1 never counts) since the last nudge or memory save;
 * - right after a compaction, once, because what was learned about the
 *   environment is exactly what a summary tends to lose.
 *
 * It never speaks twice for the same thing: a nudge, or a call to a memory
 * tool, closes both cases until the next failure pair or compaction. Like the
 * task nudge, it reads only the conversation, so a resumed or compacted
 * conversation needs no counter of its own, and it is hidden from the person.
 */
export const MEMORY_NUDGE_REPEATS = 2

const MEMORY_TOOLS = new Set(['save_memory', 'update_memory'])

function textOf(message: Message): string {
	const content = message.content as unknown
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''
	return content
		.map((block) =>
			block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
				? (block as { text: string }).text
				: '',
		)
		.join('\n')
}

/** What kind of failure a tool result reports, or `undefined` when it is not a command failure. */
export function failureSignature(message: Message): string | undefined {
	if (message.role !== 'tool' || message.isError !== true) return undefined
	const text = textOf(message)
	const code = /exited with code (\d+)/i.exec(text)?.[1]
	if (code !== undefined) return `exit ${code}`
	// A "not found" line is the shell's exit 127, so it counts with a plain exit 127: the
	// tool's error carries the status, the output carries the program name, and a pair
	// split across the two is still the same failure.
	if (/(?:^|\n|: )[\w./+-]+: (?:command )?not found/i.test(text)) return 'exit 127'
	return undefined
}

/** The failures that say something about the machine: a program missing or not runnable. */
const ENVIRONMENT_FAILURES = new Set(['exit 127', 'exit 126'])

export function memoryNudge(messages: readonly Message[]): string[] {
	const seen = new Map<string, number>()
	let repeated: string | undefined
	let afterCompaction = false
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message
		if (reminderKindOf(message) === 'memory-nudge') break
		if (
			message.role === 'assistant' &&
			message.toolCalls?.some((c) => MEMORY_TOOLS.has(c.function.name))
		)
			break
		if (message.role === 'system' && message.source?.type === 'compaction-summary') {
			afterCompaction = true
			break
		}
		const signature = failureSignature(message)
		// An ordinary red test or lint run (exit 1) is not a lesson about the machine.
		if (signature === undefined || !ENVIRONMENT_FAILURES.has(signature)) continue
		const count = (seen.get(signature) ?? 0) + 1
		seen.set(signature, count)
		if (count >= MEMORY_NUDGE_REPEATS && repeated === undefined) repeated = signature
	}
	if (repeated === undefined && !afterCompaction) return []
	// A compaction in a conversation that has just begun to be read says nothing yet:
	// there must be a person's message after it for the nudge to be about.
	if (repeated === undefined && !messages.some(isOperatorTurn)) return []
	const why =
		repeated !== undefined
			? `The same kind of failure (${repeated}) has come back more than once.`
			: 'This conversation was just compacted.'
	return [
		frameReminder(
			'memory-nudge',
			`${why} If you learned something about this machine or project that a later session would need (a missing program and where it is, a command that works, a quirk), save it in one or two lines with save_memory; load it first if it is not listed. Otherwise ignore this note. It is for you alone, so keep it out of your replies to the user.`,
		),
	]
}
