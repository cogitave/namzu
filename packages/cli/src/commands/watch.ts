/** Watch a running or finished session from another terminal, read-only. */

import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { TenantId } from '@namzu/sdk'
import { EXIT_FAIL, EXIT_NOINPUT, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import {
	type RunningSession,
	SessionFollower,
	SessionNotFoundError,
	SessionNotOwnedError,
	SessionUnreadableError,
	type WatchStatus,
	type WatchTarget,
	findSession,
	listRunningSessions,
} from '../integrations/sessions/session-watch.js'
import {
	WATCH_READ_ONLY_NOTE,
	WATCH_SETTLED_NOTE,
	WatchPrinter,
	follow,
} from '../integrations/sessions/watch-view.js'
import { ChangeWaiter } from '../integrations/sessions/watch-wait.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { readIdentity } from '../integrations/state/identity.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import type { CommandDef } from './types.js'

/** The status a script sees when the watcher was stopped by Ctrl+C or a signal. */
export const EXIT_WATCH_STOPPED = 130

const HELP = `namzu watch — follow a session from another terminal, read-only

Usage:
  namzu watch [session] [--exit-on-end] [--plain]

session        A whole session id or the start of one. Without it, the sessions
               with a turn in flight now are offered, this folder's first.

--exit-on-end  Leave when the session ends (a turn settles, or the process that
               ran it is gone) instead of staying open for the next turn.
--plain        Plain lines only: no cursor movement, no status line, for a pipe.
               This is the default when standard output is not a terminal.

This view never takes the session's lease, never writes to its log, never sends
a message and never answers an approval or a question. A session that waits for
one says so and names where to answer it: the terminal that runs the session.

Steps appear as they settle in the session's log. Text a step is still writing
appears when that step ends; the log does not hold it earlier.

Only sessions of this account on this machine are read, and nothing is opened
to the network.

Exit status with --exit-on-end:
  0   the last turn finished
  1   the last turn failed, was stopped, or stopped before finishing its work
  69  the process that ran it is gone and the turn never ended (interrupted)
Always:
  130 stopped with Ctrl+C or a signal
  64  bad arguments, or several sessions run and none was named in a pipe
  66  no such session, or none is running to offer\n`

export interface WatchArgs {
	readonly session?: string
	readonly exitOnEnd: boolean
	readonly plain: boolean
}

export function parseWatchArgs(rawArgs: readonly string[]): WatchArgs | { readonly error: string } {
	let exitOnEnd = false
	let plain = false
	const operands: string[] = []
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i] as string
		if (arg === '--') {
			operands.push(...rawArgs.slice(i + 1))
			break
		}
		if (arg === '--exit-on-end') exitOnEnd = true
		else if (arg === '--plain') plain = true
		else if (arg.startsWith('-')) return { error: `Unknown option ${arg}.` }
		else operands.push(arg)
	}
	if (operands.length > 1) return { error: 'Name one session.' }
	return { ...(operands[0] !== undefined ? { session: operands[0] } : {}), exitOnEnd, plain }
}

/** What the command needs from its surroundings; the handler fills it from the process. */
export interface WatchIO {
	readonly root: string
	readonly tenantId: TenantId
	readonly currentSlug?: string
	readonly cwd: string
	readonly write: (text: string) => void
	readonly writeError: (text: string) => void
	readonly plain: boolean
	readonly columns: number
	/** A person can be asked to choose. */
	readonly interactive: boolean
	readonly choose?: (rows: readonly RunningSession[]) => Promise<RunningSession | undefined>
	readonly signal: AbortSignal
	readonly makeWaiter: (target: WatchTarget) => {
		readonly wait: (signal: AbortSignal) => Promise<void>
		readonly close: () => void
	}
	readonly now?: () => number
	/** Whether a process of this machine is alive; for tests. */
	readonly isProcessAlive?: (pid: number) => boolean
}

export function exitCodeOf(status: WatchStatus): number {
	if (status.state === 'interrupted') return EXIT_UNAVAILABLE
	return status.outcome === 'completed' ? EXIT_OK : EXIT_FAIL
}

function offerLine(row: RunningSession, index: number): string {
	const where = row.here ? 'here' : terminalDisplayText(row.target.folder)
	return `${index + 1}. ${row.target.sessionId}  ${row.state}  ${terminalDisplayText(row.title)}  (${where})`
}

async function pick(args: WatchArgs, io: WatchIO): Promise<WatchTarget | number> {
	const base = {
		root: io.root,
		tenantId: io.tenantId,
		...(io.currentSlug ? { currentSlug: io.currentSlug } : {}),
	}
	if (args.session !== undefined) {
		try {
			return await findSession(base, args.session)
		} catch (error) {
			if (error instanceof SessionNotFoundError) {
				io.writeError(`${error.message}\n`)
				return EXIT_NOINPUT
			}
			throw error
		}
	}
	const running = await listRunningSessions({
		...base,
		...(io.now ? { now: io.now } : {}),
		...(io.isProcessAlive ? { isProcessAlive: io.isProcessAlive } : {}),
	})
	if (running.length === 0) {
		io.writeError(
			'No session has a turn running now. Give a session id to watch one that is finished or between turns.\n',
		)
		return EXIT_NOINPUT
	}
	if (running.length === 1) return (running[0] as RunningSession).target
	if (io.interactive && io.choose) {
		const chosen = await io.choose(running)
		if (!chosen) return EXIT_WATCH_STOPPED
		return chosen.target
	}
	io.writeError(
		`${running.length} sessions are running; name one:\n${running.map(offerLine).join('\n')}\n`,
	)
	return EXIT_USAGE
}

/** The whole command, against explicit surroundings. */
export async function runWatch(args: WatchArgs, io: WatchIO): Promise<number> {
	const target = await pick(args, io)
	if (typeof target === 'number') return target
	const follower = new SessionFollower({
		target,
		...(io.now ? { now: io.now } : {}),
		...(io.isProcessAlive ? { isProcessAlive: io.isProcessAlive } : {}),
	})
	const printer = new WatchPrinter({
		write: io.write,
		plain: io.plain,
		columns: io.columns,
		ended: args.exitOnEnd ? 'exit' : 'stay',
	})
	const waiter = io.makeWaiter(target)
	try {
		// Read once before announcing anything: a session that is refused or cannot be read is not announced.
		await follower.poll()
		printer.header(
			`session ${target.sessionId} in ${target.folder}. ${WATCH_READ_ONLY_NOTE} ${WATCH_SETTLED_NOTE}`,
		)
		const end = await follow({
			follower,
			printer,
			cwd: target.folder,
			exitOnEnd: args.exitOnEnd,
			signal: io.signal,
			wait: (signal) => waiter.wait(signal),
		})
		if (end.reason === 'aborted') {
			printer.close('stopped watching; the session was not touched.')
			return EXIT_WATCH_STOPPED
		}
		printer.close('the session ended; leaving.')
		return exitCodeOf(end.status)
	} catch (error) {
		printer.close()
		if (
			error instanceof SessionNotFoundError ||
			error instanceof SessionNotOwnedError ||
			error instanceof SessionUnreadableError
		) {
			io.writeError(`${error.message}\n`)
			return EXIT_NOINPUT
		}
		throw error
	} finally {
		waiter.close()
	}
}

export const watchCommand: CommandDef = {
	name: 'watch',
	description: 'Follow a running or finished session from another terminal, read-only',
	passThrough: true,
	help: HELP,
	handler: async ({ ctx, rawArgs }) => {
		const parsed = parseWatchArgs(rawArgs)
		if ('error' in parsed) {
			ctx.formatter.error({ message: `${parsed.error}\n\n${HELP}` })
			return EXIT_USAGE
		}
		const root = resolveNamzuHome()
		const identity = readIdentity(root)
		if (!identity) {
			ctx.formatter.error({
				message: 'Namzu has not been used on this machine yet, so there is no session to watch.',
			})
			return EXIT_NOINPUT
		}
		let currentSlug: string | undefined
		try {
			const { openSessionScope } = await import('../integrations/sessions/store.js')
			currentSlug = (await openSessionScope(process.cwd(), { readOnly: true })).slug
		} catch {
			// This folder has no history; sessions of other folders are still listed.
		}
		const controller = new AbortController()
		const stop = (): void => controller.abort()
		process.once('SIGINT', stop)
		process.once('SIGTERM', stop)
		process.once('SIGHUP', stop)
		const tty = process.stdout.isTTY === true
		try {
			return await runWatch(parsed, {
				root,
				tenantId: identity.tenantId,
				...(currentSlug ? { currentSlug } : {}),
				cwd: process.cwd(),
				write: (text) => void process.stdout.write(text),
				writeError: (text) => void process.stderr.write(text),
				plain: parsed.plain || !tty,
				columns: process.stdout.columns || 80,
				interactive: tty && process.stdin.isTTY === true,
				choose: async (rows) => {
					const rl = createInterface({ input: process.stdin, output: process.stderr })
					try {
						process.stderr.write(`${rows.map(offerLine).join('\n')}\n`)
						const answer = await rl.question('Watch which? (number, empty to leave) ')
						const index = Number.parseInt(answer, 10)
						return Number.isInteger(index) ? rows[index - 1] : undefined
					} finally {
						rl.close()
					}
				},
				signal: controller.signal,
				makeWaiter: (target) =>
					new ChangeWaiter({
						targets: [
							{ dir: target.paths.projectDir(), name: `${target.sessionId}.jsonl` },
							{ dir: join(target.paths.projectDir(), target.sessionId) },
						],
					}),
			})
		} finally {
			process.removeListener('SIGINT', stop)
			process.removeListener('SIGTERM', stop)
			process.removeListener('SIGHUP', stop)
		}
	},
}
