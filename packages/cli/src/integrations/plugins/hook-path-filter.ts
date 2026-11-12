/**
 * A hook's `if` for the file tools, read the way the permission rules read a
 * path: a filter on a file tool (an `Edit` or `Read` with a path glob) names
 * the same files in a hook's `if` and in a `permissions` rule (see
 * `permissions/path-rules.ts`).
 */

import type { ShellHookPathFilter } from '@namzu/sdk'

import { isPathRuleTool, pathRule, pathRuleTools } from '../../permissions/path-rules.js'

/**
 * `undefined` for a tool whose paths a rule does not read (the filter is then
 * read as it is for any other tool, which keeps its "unreadable runs the
 * hook" rule). For a file tool: `false` when the call is for a tool the rule
 * does not cover or names another path, `true` when it names this one, and
 * `undefined` when the call carries no path to compare.
 */
export function createHookPathFilter(cwd: string): ShellHookPathFilter {
	return (tool, pattern, callTool, toolInput) => {
		if (!isPathRuleTool(tool)) return undefined
		if (!pathRuleTools(tool).includes(callTool)) return false
		const input =
			toolInput !== null && typeof toolInput === 'object'
				? (toolInput as Record<string, unknown>)
				: undefined
		const written = input?.path
		const searchTool = callTool === 'grep' || callTool === 'glob' || callTool === 'ls'
		if (!(typeof written === 'string' && written !== '') && !searchTool) return undefined
		const rule = pathRule(tool, pattern, 'ask', { cwd })
		if (rule.type !== 'predicate') return undefined
		try {
			return (
				rule.decide({
					toolName: callTool,
					toolInput,
					toolDef: undefined,
					commandDialect: 'sh',
				}) !== null
			)
		} catch {
			return undefined
		}
	}
}
