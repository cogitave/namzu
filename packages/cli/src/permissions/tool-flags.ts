/**
 * `--allowed-tools` and `--disallowed-tools`: permission rules for one run.
 *
 * Each list is a set of tool entries separated by commas or spaces, where an
 * entry is a tool name (`edit`) or a tool name with a pattern in parentheses
 * (`bash(git status*)`), the same patterns a `[permissions]` table takes.
 *
 * The flags add two more layers on top of the configured ones and never
 * replace anything: a deny in any layer still wins, an `ask` still asks, and
 * an allowed entry only settles calls that nothing stricter decided.
 */

import type { PermissionsConfig, ToolPermission } from './rules.js'

export interface ToolListProblem {
	readonly flag: string
	readonly message: string
}

export interface ToolListResult {
	readonly table: PermissionsConfig | undefined
	readonly problems: readonly ToolListProblem[]
}

/** Split on commas and whitespace that sit outside parentheses. */
export function splitToolList(value: string): { items: string[]; unbalanced: boolean } {
	const items: string[] = []
	let depth = 0
	let current = ''
	for (const ch of value) {
		if (ch === '(') depth += 1
		if (ch === ')') depth = Math.max(0, depth - 1)
		if (depth === 0 && (ch === ',' || /\s/u.test(ch))) {
			if (current) items.push(current)
			current = ''
			continue
		}
		current += ch
	}
	if (current) items.push(current)
	return { items, unbalanced: depth !== 0 }
}

/** Built-in tool names are lower case; a server's tools (`mcp__a__b`) are exact. */
function toolName(name: string): string {
	return name.includes('__') ? name : name.toLowerCase()
}

/** One flag's lists as a permissions table that gives every entry `effect`. */
export function toolListTable(
	flag: string,
	lists: readonly string[],
	effect: 'allow' | 'deny',
): ToolListResult {
	const table: Record<string, Record<string, 'allow' | 'deny'> | 'allow' | 'deny'> = {}
	const problems: ToolListProblem[] = []
	for (const list of lists) {
		const { items, unbalanced } = splitToolList(list)
		if (unbalanced) {
			problems.push({ flag, message: `"${list}" has a "(" with no matching ")"` })
			continue
		}
		for (const item of items) {
			const open = item.indexOf('(')
			const name = toolName(open === -1 ? item : item.slice(0, open).trim())
			const pattern = open === -1 ? '' : item.slice(open + 1, item.lastIndexOf(')')).trim()
			if (!name || !item.endsWith(open === -1 ? item : ')')) {
				problems.push({ flag, message: `"${item}" is not a tool entry` })
				continue
			}
			const existing = table[name]
			if (pattern === '') {
				// A bare name covers every call; keep patterns already named beside it.
				table[name] = typeof existing === 'object' ? { ...existing, '*': effect } : effect
			} else if (typeof existing === 'object') {
				existing[pattern] = effect
			} else {
				table[name] = { ...(existing ? { '*': existing } : {}), [pattern]: effect }
			}
		}
	}
	return {
		table: Object.keys(table).length > 0 ? (table as Record<string, ToolPermission>) : undefined,
		problems,
	}
}

/** The permission layers the two flags add, lowest precedence first, plus anything wrong with them. */
export function toolFlagLayers(flags: {
	readonly allowedTools: readonly string[]
	readonly disallowedTools: readonly string[]
}): { layers: PermissionsConfig[]; problems: ToolListProblem[] } {
	const allowed = toolListTable('--allowed-tools', flags.allowedTools, 'allow')
	const denied = toolListTable('--disallowed-tools', flags.disallowedTools, 'deny')
	return {
		layers: [allowed.table, denied.table].filter(
			(table): table is PermissionsConfig => table !== undefined,
		),
		problems: [...allowed.problems, ...denied.problems],
	}
}
