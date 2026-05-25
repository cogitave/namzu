/**
 * `namzu serve` — run the daemon that tracks live namzu sessions so an
 * agent-view can list (and, in later phases, attach to) sessions across
 * terminals. Binds a loopback HTTP API, advertises it via the discovery
 * file, and runs until interrupted.
 */

import { startDaemon } from '../daemon/server.js'
import type { CommandDef } from './types.js'

function parsePort(rawArgs: readonly string[]): number | undefined {
	const i = rawArgs.indexOf('--port')
	if (i >= 0 && rawArgs[i + 1]) {
		const n = Number.parseInt(rawArgs[i + 1] as string, 10)
		if (Number.isInteger(n) && n >= 0 && n <= 65535) return n
	}
	return undefined
}

export const serveCommand: CommandDef = {
	name: 'serve',
	description: 'Run the namzu session daemon (agent-view backend)',
	passThrough: true,
	handler: async ({ ctx, rawArgs }) => {
		let daemon: Awaited<ReturnType<typeof startDaemon>>
		try {
			daemon = await startDaemon({
				port: parsePort(rawArgs),
				log: (line) => ctx.formatter.info(line),
			})
		} catch (err) {
			ctx.formatter.error({ message: err instanceof Error ? err.message : String(err) })
			return 1
		}

		// Run until interrupted; clean up the discovery file on the way out.
		await new Promise<void>((resolve) => {
			const stop = () => resolve()
			process.once('SIGINT', stop)
			process.once('SIGTERM', stop)
		})
		await daemon.close()
		ctx.formatter.info('namzu daemon stopped')
		return 0
	},
}
