/**
 * Adapt clawtool's MCP tool catalog into SDK `ToolDefinition`s so the
 * agent loop can call clawtool's tools alongside the SDK builtins.
 *
 * The cli's `ClawtoolMcpClient` is not the SDK's `MCPClient`, so the SDK's
 * `mcpToolToToolDefinition` can't be used directly — but its building
 * blocks (`mcpJsonSchemaToZod`, `mcpToolResultToToolResult`) are public and
 * the MCP wire shapes already match, so the adapter is a thin wrapper.
 *
 * Loading is best-effort: clawtool may be absent, down, or slow to spawn.
 * `loadClawtoolToolDefinitions` never throws and never blocks longer than
 * its timeout — on any failure it yields zero tools and the session runs on
 * builtins alone.
 */

import {
	type ToolDefinition,
	defineTool,
	mcpJsonSchemaToZod,
	mcpToolResultToToolResult,
} from '@namzu/sdk'

import { type CreateClawtoolPluginOptions, createClawtoolPlugin } from './plugin.js'
import type { ClawtoolProxyTool } from './plugin.js'

const DEFAULT_LOAD_TIMEOUT_MS = 5_000

/** Bridged clawtool tools are namespaced under this prefix. */
export const CLAWTOOL_TOOL_PREFIX = 'clawtool_'

/**
 * clawtool tools namzu never bridges (bare lowercased names). The `Agent*`
 * family is clawtool's on-disk `.claude/agents/*.md` persona manager — a
 * Claude-Code construct that writes into Claude Code's directory and is
 * redundant with (and confusing alongside) namzu's own in-memory dynamic
 * sub-agents. namzu owns sub-agent definition + dispatch natively, so these
 * are dropped before they reach the model.
 */
const EXCLUDED_CLAWTOOL_TOOLS = new Set(['agentnew', 'agentlist', 'agentdetect'])

/**
 * Convert one clawtool proxy tool into an SDK `ToolDefinition`. Pure.
 * Bridged tools are flagged destructive (clawtool's MCP descriptors carry
 * no read-only hint, so they're treated as needing consent) and run by
 * forwarding to clawtool's `tools/call`.
 */
export function clawtoolToolToDefinition(proxy: ClawtoolProxyTool): ToolDefinition {
	const inputSchema = mcpJsonSchemaToZod(
		proxy.inputSchema as Parameters<typeof mcpJsonSchemaToZod>[0],
	)
	return defineTool({
		name: `${CLAWTOOL_TOOL_PREFIX}${proxy.name}`,
		description: proxy.description ? `[clawtool] ${proxy.description}` : `[clawtool] ${proxy.name}`,
		inputSchema,
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: true,
		concurrencySafe: false,
		execute: async (input) => {
			const result = await proxy.call((input ?? {}) as Record<string, unknown>)
			return mcpToolResultToToolResult(result as Parameters<typeof mcpToolResultToToolResult>[0])
		},
	})
}

export interface LoadClawtoolToolsOptions extends CreateClawtoolPluginOptions {
	/** Tool names already provided by builtins; clawtool dupes of these are skipped. */
	readonly skipNames?: readonly string[]
	/** Hard cap on how long to wait for the daemon before giving up. */
	readonly timeoutMs?: number
}

/**
 * Connect to clawtool (spawning the daemon if needed) and adapt its tool
 * catalog, skipping any tool whose bare lowercased name duplicates a
 * builtin. Best-effort: returns `[]` on timeout or any error.
 */
export async function loadClawtoolToolDefinitions(
	opts: LoadClawtoolToolsOptions = {},
): Promise<ToolDefinition[]> {
	const { skipNames = [], timeoutMs = DEFAULT_LOAD_TIMEOUT_MS, ...pluginOpts } = opts
	const skip = new Set(skipNames.map((n) => n.toLowerCase()))
	try {
		const plugin = await withTimeout(createClawtoolPlugin(pluginOpts), timeoutMs)
		return plugin.tools
			.filter((t) => {
				const bare = t.name.toLowerCase()
				return !skip.has(bare) && !EXCLUDED_CLAWTOOL_TOOLS.has(bare)
			})
			.map(clawtoolToolToDefinition)
	} catch {
		return []
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('clawtool connect timed out')), ms)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(err) => {
				clearTimeout(timer)
				reject(err)
			},
		)
	})
}
