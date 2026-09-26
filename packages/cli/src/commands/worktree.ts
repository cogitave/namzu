/** Operator commands for durable, Namzu-owned Git worktrees. */

import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import {
	type WorktreeResume,
	openManagedWorktrees,
	worktreeOpenHint,
} from '../integrations/worktrees/managed.js'
import type { CommandDef } from './types.js'

const HELP = `namzu worktree — separate checkouts with separate conversation histories

Usage:
  namzu worktree list
  namzu worktree create [name]
  namzu worktree fork <conversation-id> [name]
  namzu worktree resume <name> [conversation-id]

Names use lowercase letters, digits and hyphens. Creation starts from this
checkout's committed HEAD. Uncommitted files stay here. "fork" copies the
settled conversation to the new checkout's project; "resume" opens its latest
conversation unless an id is given. Worktrees are never deleted automatically.\n`

/** The launcher is supplied by cli.ts so a resume uses its normal TUI setup. */
export function createWorktreeCommand(
	launch?: (target: WorktreeResume) => Promise<void>,
): CommandDef {
	return {
		name: 'worktree',
		description: 'Create, fork, list and resume managed Git worktrees',
		passThrough: true,
		help: HELP,
		handler: async ({ ctx, rawArgs }) => {
			const [verb = 'list', ...operands] = rawArgs
			if (
				!(
					(verb === 'list' && operands.length === 0) ||
					(verb === 'create' && operands.length <= 1) ||
					(verb === 'fork' && operands.length >= 1 && operands.length <= 2) ||
					(verb === 'resume' && operands.length >= 1 && operands.length <= 2)
				)
			) {
				ctx.formatter.error({ message: HELP })
				return EXIT_USAGE
			}
			try {
				const manager = await openManagedWorktrees(process.cwd())
				if (verb === 'list') {
					const worktrees = await manager.list()
					ctx.formatter.print({
						worktrees,
						text:
							worktrees.length === 0
								? 'No managed worktrees in this repository.'
								: worktrees
										.map(
											(item) =>
												`${item.label}  ${item.path}${item.dirty ? '  (uncommitted files)' : ''}`,
										)
										.join('\n'),
					})
					return EXIT_OK
				}
				if (verb === 'create') {
					const created = await manager.create(operands[0])
					ctx.formatter.print({
						...created,
						text: `Created ${created.branch} at ${created.path}.\nOpen it: ${worktreeOpenHint(created.path)}${created.sourceDirty ? '\nUncommitted files stayed in the source checkout.' : ''}`,
					})
					return EXIT_OK
				}
				if (verb === 'fork') {
					const forked = await manager.fork(operands[0] as string, operands[1])
					ctx.formatter.print({
						...forked,
						text: `Forked ${forked.copied} messages into ${forked.title} at ${forked.path}.\nOpen it: ${worktreeOpenHint(forked.path, forked.conversationId)}${forked.sourceDirty ? '\nUncommitted files stayed in the source checkout.' : ''}`,
					})
					return EXIT_OK
				}
				const target = await manager.resume(operands[0] as string, operands[1])
				if (launch && process.stdout.isTTY) {
					await launch(target)
				} else {
					ctx.formatter.print({
						...target,
						text: `Open ${target.worktree.label}: ${worktreeOpenHint(target.worktree.path, target.conversationId)}`,
					})
				}
				return EXIT_OK
			} catch (cause) {
				ctx.formatter.error({
					message: cause instanceof Error ? cause.message : String(cause),
				})
				return EXIT_USAGE
			}
		},
	}
}
