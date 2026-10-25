/**
 * Keep external tool servers from filling the model's context before a
 * single word is said.
 *
 * Every connected server's tools used to be sent in full on every request:
 * name, description and input schema. A large server does not fit. One
 * server lists 207 tools whose definitions come to about
 * 792,000 characters, more than a 200,000-token window holds, so the first
 * message overflowed and compaction, which shortens the conversation, had
 * nothing it could shorten.
 *
 * The rule: when the
 * external servers' tool definitions come to 10% of the turn's context
 * window or more, they are deferred. The model then sees each tool's name and
 * the first sentence of its description, and loads the full definition with
 * `search_tools` before it calls one. Below the threshold nothing changes and
 * every tool stays loaded. Tokens are not counted here, so the size is
 * measured in characters at a fixed rate of 2.5 characters per token.
 *
 * Decided per turn, not per session: the window belongs to the turn's model,
 * and a switch to a smaller model has to defer what a larger one could carry.
 * A tool the model has already loaded stays loaded, because availability is
 * derived from the conversation's own reveals.
 */
import { type ToolDefinition, type Toolset, deferred, toolWireSchema } from '@namzu/sdk'

/** Share of the context window, in percent, external tool definitions may take while still loaded up front. */
export const MCP_TOOL_SEARCH_PERCENT = 10

/** Characters per token where tokens are not counted. */
const CHARS_PER_TOKEN = 2.5

/**
 * A definition's size, cached per definition object: a server's tools are the
 * same objects until it reports a change, and measuring a large server means
 * serialising every schema it has.
 */
const definitionChars = new WeakMap<ToolDefinition, number>()

function charsOf(tool: ToolDefinition): number {
	const known = definitionChars.get(tool)
	if (known !== undefined) return known
	const chars =
		tool.name.length + tool.description.length + JSON.stringify(toolWireSchema(tool)).length
	definitionChars.set(tool, chars)
	return chars
}

/** An external server's main toolset that is still sent in full. Its resource tools are always deferred already. */
function isLoadedMcpToolset(ts: Toolset): boolean {
	return ts.source.kind === 'mcp_server' && (ts.availability ?? 'active') === 'active'
}

/** The size, in characters, at which external tool definitions are deferred for a window of `windowTokens`. */
export function mcpToolSearchThreshold(windowTokens: number): number {
	return Math.floor(Math.floor((windowTokens * MCP_TOOL_SEARCH_PERCENT) / 100) * CHARS_PER_TOKEN)
}

/** What the turn's external tool definitions come to, against the threshold for its window. */
export interface McpToolSearchDecision {
	readonly defer: boolean
	/** Characters of name, description and schema across every loaded external tool. */
	readonly chars: number
	readonly threshold: number
}

export function decideMcpToolSearch(
	toolsets: readonly Toolset[],
	windowTokens: number,
): McpToolSearchDecision {
	let chars = 0
	for (const ts of toolsets) {
		if (!isLoadedMcpToolset(ts)) continue
		for (const tool of ts.tools()) chars += charsOf(tool)
	}
	const threshold = mcpToolSearchThreshold(windowTokens)
	return { defer: chars > 0 && chars >= threshold, chars, threshold }
}

/**
 * `toolsets` with every loaded external server deferred, when their
 * definitions reach the threshold for `windowTokens`; `undefined` when they
 * do not, so a caller keeps the toolsets it already has.
 */
export function deferLargeMcpToolsets(
	toolsets: readonly Toolset[],
	windowTokens: number,
): readonly Toolset[] | undefined {
	if (!decideMcpToolSearch(toolsets, windowTokens).defer) return undefined
	return toolsets.map((ts) => (isLoadedMcpToolset(ts) ? deferred(ts) : ts))
}
