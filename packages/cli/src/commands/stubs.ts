/**
 * Stub commands that advertise the future surface of the CLI.
 *
 * Each stub corresponds to a milestone in the M0→M7 plan and exits 0 after
 * printing a structured marker. The implementations themselves land in
 * their respective milestone sessions (see docs.local/sessions/).
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

export const serveCommand: CommandDef = {
	name: 'serve',
	description: 'Cross-agent coordination is provided by clawtool (no separate namzu daemon)',
	handler: async ({ ctx }) => {
		ctx.formatter.info(
			'namzu uses clawtool as its coordination daemon — it registers as a BIAM peer automatically. There is no separate `namzu serve`; just run `namzu`. Use /agents to see peers.',
		)
		return 0
	},
}

export const stubCommands: readonly CommandDef[] = [skillsCommand, serveCommand]
