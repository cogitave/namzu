import type { CommandDef } from './types.js'

/** Each interactive terminal owns its local peer endpoint; no central server is required. */
export const serveCommand: CommandDef = {
	name: 'serve',
	description: 'namzu needs no central server; each session is a process',
	handler: async ({ ctx }) => {
		ctx.formatter.info(
			'namzu needs no central server. Interactive terminals in the same project can discover and message each other with /peers; each terminal owns its local endpoint. Each session is an ordinary process: start one with `namzu`, or drive the SDK directly from your own service. Nothing needs to be running first. The only long-lived process namzu has is the optional scheduler for scheduled jobs (`namzu schedule install`), and no session depends on it.',
		)
		return 0
	},
}
