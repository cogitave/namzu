/**
 * What a failed agent call or a script that could not start says, as the tool
 * itself said it.
 *
 * The person reads the error text the tool produced, the same text the model
 * gets, in the error colour: no rewording into a plain sentence. Only the
 * wrapper the tool adds around it is dropped.
 */

const WHOLE_TOOL_ERROR = /^\s*<tool_use_error>([\s\S]*)<\/tool_use_error>\s*$/i
const NESTED_TOOL_ERROR = /<\/?tool_use_error\b/i

/** The words the kernel's argument check opens with when a call's arguments do not fit its schema. */
const BAD_ARGUMENTS =
	/^(?:InputValidationError: |Validation failed for "|Tool "[^"]+" was called with no arguments\.)/

/** The failure text of a tool result, ready to draw. `expanded` is the Ctrl+O view. */
export function toolFailureText(output: string | undefined, expanded: boolean): string {
	if (output === undefined) return 'Tool execution failed'
	const inner = WHOLE_TOOL_ERROR.exec(output)?.[1]
	const unwrapped = inner !== undefined && !NESTED_TOOL_ERROR.test(inner) ? inner : output
	const text = unwrapped
		.replace(/<sandbox_violations>[\s\S]*?<\/sandbox_violations>/g, '')
		.replace(/<\/?error>/g, '')
		.trim()
	if (!expanded && BAD_ARGUMENTS.test(text)) return 'Invalid tool parameters'
	return text.startsWith('Error: ') || text.startsWith('Cancelled: ') ? text : `Error: ${text}`
}

/** The first line of a failure text: all a script that could not start shows. */
export function firstLineOf(text: string): string {
	return text.split('\n', 1)[0] ?? ''
}
