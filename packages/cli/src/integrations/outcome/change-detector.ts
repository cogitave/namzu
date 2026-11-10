import { LocalExecutionContext, fingerprintWorkspace } from '@namzu/sdk'

/**
 * How the turn's outcome record watches the working directory: a fingerprint of
 * what git can see there, `null` whenever it cannot be told (not a repository,
 * no commits, git absent, too slow). `null` is never read as "unchanged"; the
 * record then falls back to what the kernel's own write tools did.
 *
 * Bound to the directory the turn's tools really change. A turn whose tools
 * work in a sandbox's own copy, or in a worktree of their own, does not get
 * one: the directory this would read is not the one they write.
 */
export function workspaceChangeDetector(cwd: string): () => Promise<string | null> {
	const context = new LocalExecutionContext({ id: 'namzu-turn-outcome', cwd })
	return () =>
		fingerprintWorkspace({
			cwd,
			// Per git call. The record's own deadline for the whole answer is shorter.
			timeoutMs: 2_500,
			exec: (command, args, options) => context.executeCommand(command, args, options),
		})
}

/**
 * The detector for a turn, or `undefined` where the directory it would read is
 * not the one the turn's tools change: a sandbox that works in a copy of its own
 * ('ephemeral') leaves the working directory as it was.
 */
export function changeDetectorFor(
	cwd: string,
	sandbox: { readonly active: boolean; readonly workspace: 'working-directory' | 'ephemeral' },
): (() => Promise<string | null>) | undefined {
	if (sandbox.active && sandbox.workspace !== 'working-directory') return undefined
	return workspaceChangeDetector(cwd)
}
