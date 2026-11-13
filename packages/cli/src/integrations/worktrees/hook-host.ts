/**
 * The `worktree_create` and `worktree_remove` hooks for a command that runs
 * outside a conversation (`namzu worktree create`, `/worktree create` before a
 * conversation has started). They are the same hooks a session runs, read from
 * the same configuration, on a hook runtime of their own.
 */

import { randomUUID } from 'node:crypto'
import { worktreeHookHost } from '@namzu/sdk'
import type { WorktreeHookHost } from '@namzu/sdk'
import type { HooksConfig, NamzuCliConfig } from '../../config/schema.js'
import { createCliPluginRuntime } from '../plugins/runtime.js'

export interface WorktreeHookRuntime {
	/** Absent when no hook is configured: the kernel's own Git logic does the work. */
	readonly hooks?: {
		readonly host: () => WorktreeHookHost | undefined
		readonly onNotice: (line: string) => void
	}
	close(): Promise<void>
}

export async function openWorktreeHookRuntime(
	config: { readonly plugins?: NamzuCliConfig['plugins']; readonly hooks?: HooksConfig },
	cwd: string,
	say: (line: string) => void,
): Promise<WorktreeHookRuntime> {
	const sessionId = randomUUID()
	const runtime = await createCliPluginRuntime(config.plugins, cwd, config.hooks, {
		sessionId: () => sessionId,
	})
	if (runtime === undefined) return { close: async () => undefined }
	const stop = runtime.hookActivity.onNotice(say)
	const host = worktreeHookHost(runtime.manager, () => sessionId)
	return {
		hooks: { host: () => host, onNotice: say },
		close: async () => {
			stop()
			await runtime.close()
		},
	}
}
