/**
 * Stub commands that advertise the future surface of the CLI.
 *
 * Each stub corresponds to a milestone in the M0→M7 plan and exits 0 after
 * printing a structured marker. The implementations themselves land in
 * their respective milestone sessions (agent working memory, gitignored).
 */

import type { CommandDef, CommandHandler } from './types.js'

function stubHandler(milestone: string, what: string): CommandHandler {
	return async ({ ctx }) => {
		ctx.formatter.print({
			stub: true,
			milestone,
			message: `${milestone} will implement ${what}.`,
		})
		return 0
	}
}

export const skillsCommand: CommandDef = {
	name: 'skills',
	description: 'Manage agentskills.io-compatible skills (M5)',
	handler: stubHandler('M5', 'the skills subsystem'),
}

/**
 * Kept as a command rather than deleted, because someone typing it deserves an
 * answer and "unknown command" is a worse one.
 *
 * Its previous answer was the second half of a sentence that no longer has a
 * first half: it said cross-agent coordination came from an external daemon, so
 * there was no separate namzu one. That integration is gone, and the honest
 * replacement is the other claim outright rather than a different name — namzu
 * has no daemon and no coordination surface today.
 */
export const serveCommand: CommandDef = {
	name: 'serve',
	description: 'namzu has no daemon; a run is a process',
	handler: async ({ ctx }) => {
		ctx.formatter.info(
			'namzu has no daemon and no cross-agent coordination surface. A run is an ordinary process: start one with `namzu`, or drive the SDK directly from your own service. Nothing needs to be running first.',
		)
		return 0
	},
}

export const stubCommands: readonly CommandDef[] = [skillsCommand, serveCommand]
