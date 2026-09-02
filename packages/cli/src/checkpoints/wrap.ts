/**
 * The file tools, with a checkpoint taken before each write.
 *
 * Wrapping `execute` rather than hooking `pre_tool_use`: a hook needs the
 * plugin lifecycle manager, which a session without plugins or hooks does
 * not build, and a checkpoint must not depend on which other features are
 * on. The wrapper reads the file the tool is about to change, records it,
 * and then runs the tool untouched.
 */

import type { ToolContext, ToolDefinition, ToolResult } from '@namzu/sdk'

import type { FileCheckpointStore } from './store.js'

/** Tools whose `path` names a file they will change. */
export const CHECKPOINTED_TOOLS: readonly string[] = ['edit', 'write']

function pathOf(input: unknown): string | undefined {
	if (input === null || typeof input !== 'object') return undefined
	const path = (input as { path?: unknown }).path
	return typeof path === 'string' && path.length > 0 ? path : undefined
}

export function withCheckpoints(tool: ToolDefinition, store: FileCheckpointStore): ToolDefinition {
	return {
		...tool,
		execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
			const path = pathOf(input)
			if (path !== undefined) {
				try {
					await store.snapshot(path)
				} catch (err) {
					// A checkpoint that cannot be taken must not stop the edit;
					// it is a safety net under the work, not a gate on it.
					context.log(
						'warn',
						`checkpoint skipped for ${path}: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}
			return tool.execute(input, context)
		},
	}
}
