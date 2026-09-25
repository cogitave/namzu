/**
 * Match a hierarchical source id against a glob pattern.
 *
 * Source ids are strings like `mcp:github`, `plugin:acme`,
 * `plugin:acme/mcp:db` (plan.md §1) — no filesystem semantics, so this is
 * not a path glob: `*` matches any run of characters, including `/` and
 * `:`, so `plugin:acme/*` matches `plugin:acme/mcp:db` in one step. There
 * is no `**`, `?` or character class — the id space does not need them, and
 * a smaller matcher is one with no surprising cases to test.
 *
 * A pattern with no `*` is an exact match, so callers never have to special
 * case "no wildcard" themselves.
 */
export function matchesSourceIdGlob(id: string, pattern: string): boolean {
	if (!pattern.includes('*')) return id === pattern
	const escaped = pattern.split('*').map(escapeRegExpLiteral).join('.*')
	return new RegExp(`^${escaped}$`).test(id)
}

function escapeRegExpLiteral(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
