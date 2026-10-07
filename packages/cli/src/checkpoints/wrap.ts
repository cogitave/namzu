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
			// The journal's turn, so an edit from a resumed stream lands in its own
			// turn rather than whichever prompt began last.
			const turnId = context.turnId as string | undefined
			let covered = false
			let recorded = false
			if (path !== undefined) {
				if (context.sandbox) {
					// The tool acts on the sandbox's filesystem, where `path` is not the
					// host path of the same name. Snapshotting it would capture the host
					// file, and a restore would then write that over, or unlink, a host
					// file this turn never touched.
					await store.recordSkip(path, 'sandbox', turnId).catch(() => undefined)
					context.log('warn', `checkpoint skipped for ${path}: the edit runs in the sandbox`)
				} else {
					try {
						const result = await store.snapshot(path, {
							turnId,
							tool: tool.name,
							toolUseId: context.toolUseId,
						})
						recorded = result === 'recorded'
						covered = recorded || result === 'already'
						if (result === 'too-large' || result === 'outside') {
							context.log('warn', `checkpoint skipped for ${path}: ${result}`)
						}
					} catch (err) {
						// A checkpoint that cannot be taken must not stop the edit;
						// it is a safety net under the work, not a gate on it.
						await store.recordSkip(path, 'snapshot-failed', turnId).catch(() => undefined)
						context.log(
							'warn',
							`checkpoint skipped for ${path}: ${err instanceof Error ? err.message : String(err)}`,
						)
					}
				}
			}
			// Where the file ended up is recorded whatever the call did: a refused
			// edit that changed nothing takes its entry back, a half-done one keeps it.
			const settle = async (ok: boolean) => {
				if (!covered || path === undefined) return
				await store.settle(path, { ok, first: recorded, turnId }).catch(() => undefined)
			}
			let result: ToolResult
			try {
				result = await tool.execute(input, context)
			} catch (err) {
				await settle(false)
				throw err
			}
			await settle(result.success)
			return result
		},
	}
}

/** Tools that change files by running something: undo cannot reverse them. */
export const SHELL_TOOLS: readonly string[] = ['bash', 'job', 'run_code']

/** Note, per turn, that a shell call ran, so the history can say what it does not cover. */
export function withShellNote(tool: ToolDefinition, store: FileCheckpointStore): ToolDefinition {
	return {
		...tool,
		execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
			await store.noteShell(context.turnId as string | undefined).catch(() => undefined)
			return tool.execute(input, context)
		},
	}
}
