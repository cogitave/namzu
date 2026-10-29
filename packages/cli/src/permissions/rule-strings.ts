/**
 * Rules written as a list of strings: `permissions.allow`, `permissions.ask`
 * and `permissions.deny`, each entry `Tool` or `Tool(specifier)`.
 *
 * This is a second spelling of the per-tool table, folded into it when the
 * config is loaded, so everything after the loader sees one shape. The table
 * keeps working and the two can be mixed in one file.
 *
 *     permissions:
 *       allow: ["Bash(git status:*)", "Read(./docs/**)"]
 *       deny:  ["Bash(rm -rf *)", "Read(./.env)", "mcp__files__delete"]
 *
 * An empty or `*` specifier means the whole tool. A trailing `:*` is the same
 * as a trailing space and star (`git push:*` is `git push *`). A literal
 * parenthesis in a specifier is written `\(` and `\)`.
 */

import type { PermissionEffect, ToolPermission } from './rules.js'

export const RULE_LIST_KEYS = ['allow', 'ask', 'deny'] as const
type RuleListKey = (typeof RULE_LIST_KEYS)[number]

export function isRuleListKey(key: string): key is RuleListKey {
	return (RULE_LIST_KEYS as readonly string[]).includes(key)
}

export interface ParsedRuleString {
	readonly tool: string
	/** Absent when the rule covers every call to the tool. */
	readonly specifier?: string
}

/** The stricter of two effects: deny, then ask, then allow. */
function stricter(a: PermissionEffect, b: PermissionEffect): PermissionEffect {
	const order: PermissionEffect[] = ['deny', 'ask', 'allow']
	return order.indexOf(a) <= order.indexOf(b) ? a : b
}

/** `WebFetch` becomes `web_fetch`; names that already start lower-case, and MCP names, are kept. */
function toolNameOf(written: string): string {
	if (written.startsWith('mcp__') || /^[a-z]/.test(written)) return written
	return written.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** Split `Tool(spec)`; undefined when the parentheses do not balance as one trailing group. */
export function parseRuleString(entry: string): ParsedRuleString | undefined {
	const text = entry.trim()
	if (!text) return undefined
	const open = text.search(/(?<!\\)\(/)
	if (open === -1) {
		return /[()]/.test(text.replaceAll('\\(', '').replaceAll('\\)', ''))
			? undefined
			: { tool: toolNameOf(text) }
	}
	const name = text.slice(0, open)
	if (!name || /[()\s]/.test(name) || !text.endsWith(')') || text.endsWith('\\)')) return undefined
	const raw = text.slice(open + 1, -1)
	if (/(?<!\\)[()]/.test(raw)) return undefined
	const specifier = raw.replaceAll('\\(', '(').replaceAll('\\)', ')')
	const tool = toolNameOf(name)
	return specifier === '' || specifier === '*' ? { tool } : { tool, specifier }
}

/**
 * The table pattern for one specifier.
 *
 * `domain:host` on the fetch tool becomes a URL pattern. A file tool's
 * specifier is a path and is kept as written; the path rule resolves it.
 */
export function patternOf(tool: string, specifier: string, effect: PermissionEffect): string {
	let pattern = specifier
	if (pattern.endsWith(':*')) pattern = `${pattern.slice(0, -2)} *`
	if (tool === 'web_fetch' && pattern.startsWith('domain:')) {
		const host = pattern.slice('domain:'.length)
		return effect === 'allow' ? `*://${host}/*` : `*://${host}*`
	}
	return pattern
}

export interface FoldResult {
	readonly table: Record<string, unknown>
	/** Entries that could not be read, as `{ path, message }` for the loader to raise. */
	readonly problem?: { readonly path: readonly string[]; readonly message: string }
}

/**
 * Fold `allow`/`ask`/`deny` lists into the per-tool table. A table without
 * any of the three comes back unchanged. When two rules disagree about the
 * same tool or pattern, the stricter one stands.
 */
export function foldRuleLists(table: Readonly<Record<string, unknown>>): FoldResult {
	const lists = RULE_LIST_KEYS.filter((key) => Array.isArray(table[key]))
	if (lists.length === 0) return { table: { ...table } }

	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(table)) {
		if (!(isRuleListKey(key) && Array.isArray(value))) out[key] = value
	}
	const wholeTool = new Map<string, PermissionEffect>()
	const patterns = new Map<string, Map<string, PermissionEffect>>()
	for (const key of lists) {
		const entries = table[key] as unknown[]
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]
			const parsed = typeof entry === 'string' ? parseRuleString(entry) : undefined
			if (!parsed) {
				return {
					table: out,
					problem: {
						path: [key, String(i)],
						message: `${JSON.stringify(entry)} is not a rule; write a tool name, or a tool name with a specifier in parentheses, such as Bash(git status *)`,
					},
				}
			}
			if (parsed.specifier === undefined) {
				const had = wholeTool.get(parsed.tool)
				wholeTool.set(parsed.tool, had ? stricter(had, key) : key)
				continue
			}
			const forTool = patterns.get(parsed.tool) ?? new Map<string, PermissionEffect>()
			const pattern = patternOf(parsed.tool, parsed.specifier, key)
			const had = forTool.get(pattern)
			forTool.set(pattern, had ? stricter(had, key) : key)
			patterns.set(parsed.tool, forTool)
		}
	}
	const tools = new Set([...wholeTool.keys(), ...patterns.keys()])
	for (const tool of tools) {
		const existing = out[tool] as ToolPermission | undefined
		const whole = wholeTool.get(tool)
		const found = patterns.get(tool)
		if (!found && !(existing && typeof existing === 'object')) {
			const prior = typeof existing === 'string' ? existing : undefined
			if (whole) out[tool] = prior ? stricter(prior, whole) : whole
			continue
		}
		const merged: Record<string, PermissionEffect> =
			existing && typeof existing === 'object' ? { ...existing } : {}
		if (typeof existing === 'string') merged['*'] = existing
		if (whole) merged['*'] = merged['*'] ? stricter(merged['*'], whole) : whole
		for (const [pattern, effect] of found ?? []) {
			const had = merged[pattern]
			merged[pattern] = had ? stricter(had, effect) : effect
		}
		out[tool] = merged
	}
	return { table: out }
}
