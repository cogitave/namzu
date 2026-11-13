/** Operator commands for durable, Namzu-owned Git worktrees. */

import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import { displayConversationTitle } from '../integrations/sessions/display-title.js'
import { openWorktreeHookRuntime } from '../integrations/worktrees/hook-host.js'
import {
	type WorktreeResume,
	openManagedWorktrees,
	worktreeOpenHint,
} from '../integrations/worktrees/managed.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
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
			let hookRuntime: Awaited<ReturnType<typeof openWorktreeHookRuntime>> | undefined
			try {
				// Only a command that makes a worktree reaches a hook; listing and
				// resuming never start the hook runtime.
				if (verb === 'create' || verb === 'fork') {
					// A folder's own hooks run only once a person trusted it, as for every
					// command; before that only the user's and the managed file's do. This
					// command's context carries no configuration, so the hooks are read here.
					const trust = decideHeadlessTrust({ cwd: process.cwd(), trustFlag: false })
					const { loadBootstrapConfigWithProvenance, loadConfigWithProvenance } = await import(
						'../config/load.js'
					)
					const config = trust.allowed
						? loadConfigWithProvenance({ cwd: trust.cwd }).config
						: loadBootstrapConfigWithProvenance({}).config
					hookRuntime = await openWorktreeHookRuntime(config, process.cwd(), (line) =>
						ctx.formatter.info(terminalDisplayText(line)),
					)
				}
				const manager = await openManagedWorktrees(process.cwd(), {
					...(hookRuntime?.hooks
						? { hooks: hookRuntime.hooks.host, onNotice: hookRuntime.hooks.onNotice }
						: {}),
				})
				if (verb === 'list') {
					const worktrees = await manager.list()
					const text =
						worktrees.length === 0
							? 'No managed worktrees in this repository.'
							: worktrees
									.map(
										(item) =>
											`${item.label}  ${item.path}${item.dirty ? '  (uncommitted files)' : ''}`,
									)
									.join('\n')
					ctx.formatter.print({
						worktrees,
						text: terminalDisplayText(text),
					})
					return EXIT_OK
				}
				if (verb === 'create') {
					const created = await manager.create(operands[0])
					ctx.formatter.print({
						...created,
						text: terminalDisplayText(
							created.madeByHook
								? `Created a worktree at ${created.path} with a worktree_create hook.\nOpen it: ${worktreeOpenHint(created.path)}\nNamzu does not manage it: it is not in \`namzu worktree list\`, and removing it is a worktree_remove hook's job or yours.`
								: `Created ${created.branch} at ${created.path}.\nOpen it: ${worktreeOpenHint(created.path)}${created.sourceDirty ? '\nUncommitted files stayed in the source checkout.' : ''}`,
						),
					})
					return EXIT_OK
				}
				if (verb === 'fork') {
					const forked = await manager.fork(operands[0] as string, operands[1])
					ctx.formatter.print({
						...forked,
						text: terminalDisplayText(
							`Forked ${forked.copied} messages into ${displayConversationTitle(forked.title)} at ${forked.path}.\nOpen it: ${worktreeOpenHint(forked.path, forked.conversationId)}${forked.sourceDirty ? '\nUncommitted files stayed in the source checkout.' : ''}`,
						),
					})
					return EXIT_OK
				}
				const target = await manager.resume(operands[0] as string, operands[1])
				if (launch && process.stdout.isTTY) {
					await launch(target)
				} else {
					ctx.formatter.print({
						...target,
						text: terminalDisplayText(
							`Open ${target.worktree.label}: ${worktreeOpenHint(target.worktree.path, target.conversationId)}`,
						),
					})
				}
				return EXIT_OK
			} catch (cause) {
				ctx.formatter.error({
					message: terminalDisplayText(cause instanceof Error ? cause.message : String(cause)),
				})
				return EXIT_USAGE
			} finally {
				await hookRuntime?.close().catch(() => undefined)
			}
		},
	}
}
