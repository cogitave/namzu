import { createHash } from 'node:crypto'
import type { MCPToolDefinition } from '../../types/connector/index.js'

/**
 * What a host will accept from an MCP server.
 *
 * Discovery used to take whatever the server offered, which puts the
 * REMOTE side in charge of what enters the agent's tool registry — the
 * exact inversion of least privilege. A server could add a tool between
 * two runs and it became callable with no one having agreed to it.
 */
export interface MCPToolPolicy {
	/**
	 * Names (as the SERVER reports them, before the `mcp_<server>_` prefix)
	 * that may be admitted. When set, nothing else is, and a tool that
	 * appears later is refused by default rather than admitted by default.
	 */
	readonly allow?: readonly string[]
	/** Names that are never admitted, even if `allow` lists them. */
	readonly deny?: readonly string[]
}

export interface MCPToolPolicyDecision {
	readonly admitted: MCPToolDefinition[]
	/** Refused tools, with the reason, so a host can log or surface them. */
	readonly refused: ReadonlyArray<{ name: string; reason: 'not_allowed' | 'denied' }>
}

/**
 * Apply a policy to one server's advertised tools.
 *
 * Deny beats allow. A name on both lists is refused — the restrictive
 * reading is the only safe one when a config contradicts itself.
 */
export function applyToolPolicy(
	tools: readonly MCPToolDefinition[],
	policy: MCPToolPolicy | undefined,
): MCPToolPolicyDecision {
	if (!policy || (!policy.allow && !policy.deny)) {
		return { admitted: [...tools], refused: [] }
	}

	const allow = policy.allow ? new Set(policy.allow) : null
	const deny = new Set(policy.deny ?? [])

	const admitted: MCPToolDefinition[] = []
	const refused: Array<{ name: string; reason: 'not_allowed' | 'denied' }> = []

	for (const tool of tools) {
		if (deny.has(tool.name)) {
			refused.push({ name: tool.name, reason: 'denied' })
			continue
		}
		if (allow && !allow.has(tool.name)) {
			refused.push({ name: tool.name, reason: 'not_allowed' })
			continue
		}
		admitted.push(tool)
	}

	return { admitted, refused }
}

/**
 * A stable fingerprint of what a server is offering.
 *
 * Covers each tool's name, description and input schema — everything the
 * model is shown and everything that determines what a call does. A server
 * can advertise a benign tool at approval time and swap its description or
 * schema afterwards; nothing about the tool NAME changes, so a name-only
 * check would miss it entirely.
 *
 * Sorted by name and serialized with sorted keys so the hash reflects
 * meaning rather than transport ordering.
 */
export function toolsHash(tools: readonly MCPToolDefinition[]): string {
	const canonical = [...tools]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((tool) => ({
			name: tool.name,
			description: tool.description ?? '',
			inputSchema: stableStringify(tool.inputSchema),
		}))

	return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** What changed between two discoveries of the same server. */
export interface MCPToolDrift {
	readonly added: string[]
	readonly removed: string[]
	/** Same name, different description or schema — the rug-pull shape. */
	readonly changed: string[]
}

export function diffTools(
	before: readonly MCPToolDefinition[],
	after: readonly MCPToolDefinition[],
): MCPToolDrift {
	const beforeByName = new Map(before.map((t) => [t.name, t]))
	const afterByName = new Map(after.map((t) => [t.name, t]))

	const added = [...afterByName.keys()].filter((name) => !beforeByName.has(name))
	const removed = [...beforeByName.keys()].filter((name) => !afterByName.has(name))
	const changed = [...afterByName.keys()].filter((name) => {
		const prev = beforeByName.get(name)
		if (!prev) return false
		const next = afterByName.get(name) as MCPToolDefinition
		return toolsHash([prev]) !== toolsHash([next])
	})

	return { added, removed, changed }
}

export function hasDrift(drift: MCPToolDrift): boolean {
	return drift.added.length > 0 || drift.removed.length > 0 || drift.changed.length > 0
}

/** JSON with object keys sorted at every depth, so key order cannot move a hash. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a.localeCompare(b),
	)
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}
