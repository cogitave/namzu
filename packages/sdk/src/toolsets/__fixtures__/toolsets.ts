import { z } from 'zod'
import type { ToolDefinition } from '../../types/tool/index.js'
import type { Toolset } from '../types.js'

/** A minimal, otherwise-inert `ToolDefinition`, for tests across this directory. */
export function tool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		description: `${name} tool`,
		inputSchema: z.object({}),
		async execute() {
			return { success: true, output: `${name} ran` }
		},
		...extra,
	} as unknown as ToolDefinition
}

/**
 * A toolset whose tool list can change after construction and that reports
 * those changes through `onChange`, for exercising live propagation and
 * `close()` without a real MCP connection.
 */
export function liveToolset(sourceId: string, initialTools: readonly ToolDefinition[]) {
	let current = initialTools
	const listeners = new Set<() => void>()
	let closeCalls = 0
	const ts: Toolset = {
		source: { id: sourceId, kind: 'mcp_server', name: sourceId },
		tools: () => current,
		onChange: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		close: async () => {
			closeCalls += 1
		},
	}
	return {
		toolset: ts,
		setTools(next: readonly ToolDefinition[]): void {
			current = next
			for (const listener of listeners) listener()
		},
		listenerCount: () => listeners.size,
		closeCalls: () => closeCalls,
	}
}
