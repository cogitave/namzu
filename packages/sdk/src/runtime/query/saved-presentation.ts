import { genericPrimary } from '../../registry/tool/presentation.js'
import type { ToolCallView, ToolResultView } from '../../types/tool/presentation.js'

/** One line is all a saved row needs; the output is not kept. */
export const SAVED_LABEL_MAX = 200

function firstLine(text: string | undefined): string | undefined {
	const line = text
		?.split(/\r?\n/)
		.find((candidate) => candidate.trim())
		?.trim()
	if (!line) return undefined
	// By code point so a surrogate pair is never split.
	const points = Array.from(line)
	return points.length > SAVED_LABEL_MAX
		? `${points.slice(0, SAVED_LABEL_MAX - 1).join('')}…`
		: line
}

/**
 * What the journal keeps of a successful call that has no diff: the label the
 * live row already showed, never the output. A host that replays history then
 * names the action instead of calling it a saved one.
 *
 * `undefined` means there is nothing worth saving (no label, no command), so
 * the host falls back to the tool's name.
 */
export function savedPresentation(
	input: unknown,
	callView: ToolCallView | undefined,
	resultView: ToolResultView | undefined,
): ToolResultView | undefined {
	if (resultView?.kind === 'diff') return undefined
	const callLabel = callView?.kind === 'generic' ? firstLine(callView.label) : undefined
	const commandInput =
		input &&
		typeof input === 'object' &&
		typeof (input as { command?: unknown }).command === 'string'
			? (input as { command: string }).command
			: undefined
	// A tool with no view of its own is drawn as a terminal, so a command input is a command.
	const command =
		resultView?.kind === 'terminal' || callView?.kind === 'terminal'
			? ((resultView?.kind === 'terminal' ? resultView.command : undefined) ??
				(callView?.kind === 'terminal' ? callView.command : undefined) ??
				commandInput ??
				callLabel ??
				'')
			: !resultView && !callView && commandInput !== undefined
				? commandInput
				: undefined
	if (command !== undefined) {
		const line = firstLine(command)
		return line ? { kind: 'terminal', command: line, output: '' } : undefined
	}
	const label =
		callLabel ??
		(resultView?.kind === 'generic' ? firstLine(resultView.label) : undefined) ??
		(callView || resultView ? undefined : firstLine(genericPrimary(input)))
	if (!label) return undefined
	const own = callView?.kind === 'generic' ? callView : undefined
	const hidden = resultView?.kind === 'generic' && resultView.visibility === 'hidden'
	return {
		kind: 'generic',
		label,
		...(own?.presentation === 'activity' ? { presentation: 'activity' as const } : {}),
		...(own?.activity === 'exploration' ? { activity: 'exploration' as const } : {}),
		...(hidden ? { visibility: 'hidden' as const } : {}),
	}
}
