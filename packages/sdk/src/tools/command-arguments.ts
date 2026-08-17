/**
 * Which argument of a tool holds a shell command line.
 *
 * ## Why a host needs this
 *
 * A host that compiles operator config into gate rules has a tool NAME and a
 * pattern, and needs an argument to attach the pattern to. Without one it can
 * only reach for `custom_pattern`, whose subject is `JSON.stringify(input)` —
 * and matching a glob against a serialised object costs both halves of what an
 * operator meant. The pattern can match the start of any argument's value
 * rather than the one they had in mind, and it stays open on the right, so
 * `bash = { "git status*" = "allow" }` compiled to a rule that also approved
 * `git status && rm -rf ~`.
 *
 * `argument_pattern` has neither problem, and it reads the value as the
 * commands it runs. Reaching it needs exactly one fact this function supplies.
 *
 * ## Why it is derived rather than written down
 *
 * A list of "tools whose first argument is a command" maintained beside the
 * tools is a list that drifts from them, and this repository has now gated
 * that same shape four times. So the fact lives on the tool as
 * {@link ToolDefinition.commandArgument} and this reads it back.
 *
 * A host with its own tools should ask {@link commandArgumentOf} with the
 * definition it already holds. {@link builtinCommandArguments} exists for the
 * case where only the name is available — permission config is compiled before
 * any tool is constructed — and answers for the builtin set alone. An unknown
 * name gets `undefined`, which is a host falling back to what it did before
 * rather than a wrong answer.
 */

import type { ToolDefinition } from '../types/tool/index.js'
import { getBuiltinTools } from './builtins/index.js'

/** The argument holding a command line, or undefined when the tool has none. */
export function commandArgumentOf(tool: ToolDefinition): string | undefined {
	return tool.commandArgument
}

/**
 * The builtin tools that take a command line, by tool name.
 *
 * Computed on each call rather than cached at module load: a frozen snapshot
 * taken at import time is a copy of the registry, and a copy is the thing this
 * module exists to avoid.
 */
export function builtinCommandArguments(): ReadonlyMap<string, string> {
	const byName = new Map<string, string>()
	for (const tool of getBuiltinTools()) {
		if (tool.commandArgument !== undefined) byName.set(tool.name, tool.commandArgument)
	}
	return byName
}
