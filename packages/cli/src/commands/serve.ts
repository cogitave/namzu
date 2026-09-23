import type { CommandDef } from './types.js'

/**
 * Kept as a command rather than deleted, because someone typing it deserves an
 * answer and "unknown command" is a worse one.
 *
 * Its previous answer was the second half of a sentence that no longer has a
 * first half: it said cross-agent coordination came from an external daemon, so
 * there was no separate namzu one. That integration is gone, and the honest
 * replacement is the other claim outright rather than a different name — namzu
 * has no server and no coordination surface today. The one long-lived process
 * it has is the scheduler (`namzu schedule`), which runs scheduled jobs and
 * nothing else; sessions never need it.
 */
export const serveCommand: CommandDef = {
	name: 'serve',
	description: 'namzu has no server; each session is a process',
	handler: async ({ ctx }) => {
		ctx.formatter.info(
			'namzu has no server and no cross-agent coordination surface. Each session is an ordinary process: start one with `namzu`, or drive the SDK directly from your own service. Nothing needs to be running first. The only long-lived process namzu has is the optional scheduler for scheduled jobs (`namzu schedule install`), and no session depends on it.',
		)
		return 0
	},
}
