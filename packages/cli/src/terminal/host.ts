import { cliLogger } from '../logging.js'
import { type TerminalEvent, TerminalManager } from './manager.js'
import {
	TERMINAL_LIMITS,
	TERMINAL_METHODS,
	TERMINAL_NOTIFICATIONS,
	type TerminalStatus,
	readAck,
	readAttach,
	readCreate,
	readDetach,
	readResize,
	readTerminalOnly,
	readWrite,
} from './protocol.js'
import { type HostPtyLoader, loadHostPty, quietConptyHelper } from './pty.js'

export interface TerminalHost {
	/** Extension methods for the protocol server. */
	readonly extensions: Readonly<Record<string, (params: Record<string, unknown>) => unknown>>
	readonly manager: TerminalManager
	/** End every terminal. Awaited by the process before it exits. */
	close(): Promise<void>
}

export interface TerminalHostOptions {
	readonly cwd: string
	/** Sends one notification to the connected client. */
	readonly notify: (method: string, params: Record<string, unknown>) => void
	readonly loadPty?: HostPtyLoader
	readonly platform?: NodeJS.Platform
	readonly env?: NodeJS.ProcessEnv
	readonly defer?: (run: () => void) => void
	readonly killGraceMs?: number
}

/** The `namzu/terminal/*` methods over one manager. */
export function createTerminalHost(options: TerminalHostOptions): TerminalHost {
	const platform = options.platform ?? process.platform
	const loader = options.loadPty
	quietConptyHelper(undefined, platform)
	const emit = (event: TerminalEvent): void => {
		try {
			options.notify(
				event.type === 'data' ? TERMINAL_NOTIFICATIONS.data : TERMINAL_NOTIFICATIONS.exit,
				{ ...event.params },
			)
		} catch (error) {
			cliLogger().warn('terminal notification failed', {
				'namzu.terminal.error': error instanceof Error ? error.message : String(error),
			})
		}
	}
	const manager = new TerminalManager({
		loadPty: () => loadHostPty(loader),
		emit,
		cwd: options.cwd,
		platform,
		...(options.env ? { env: options.env } : {}),
		...(options.defer ? { defer: options.defer } : {}),
		...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
	})
	const extensions = {
		[TERMINAL_METHODS.status]: async (): Promise<TerminalStatus> => {
			const state = await manager.available()
			return {
				available: state.available,
				...(state.available ? {} : { reason: state.reason }),
				platform,
				limits: {
					maxTerminals: TERMINAL_LIMITS.maxTerminals,
					maxCols: TERMINAL_LIMITS.maxCols,
					maxRows: TERMINAL_LIMITS.maxRows,
					maxWrite: TERMINAL_LIMITS.maxWrite,
					maxChunk: TERMINAL_LIMITS.maxChunk,
				},
			}
		},
		[TERMINAL_METHODS.create]: async (params: Record<string, unknown>) => ({
			terminal: await manager.create(readCreate(params)),
		}),
		[TERMINAL_METHODS.list]: (params: Record<string, unknown>) => {
			if (Object.keys(params).length > 0) throw new Error('Invalid terminal list request.')
			return { terminals: manager.list() }
		},
		[TERMINAL_METHODS.attach]: (params: Record<string, unknown>) =>
			manager.attach(readAttach(params)),
		[TERMINAL_METHODS.detach]: (params: Record<string, unknown>) => {
			manager.detach(readDetach(params))
			return {}
		},
		[TERMINAL_METHODS.write]: (params: Record<string, unknown>) => {
			const request = readWrite(params)
			manager.write(request)
			return { written: request.data.length }
		},
		[TERMINAL_METHODS.resize]: (params: Record<string, unknown>) => {
			manager.resize(readResize(params))
			return {}
		},
		[TERMINAL_METHODS.ack]: (params: Record<string, unknown>) => {
			manager.ack(readAck(params))
			return {}
		},
		[TERMINAL_METHODS.kill]: async (params: Record<string, unknown>) => {
			await manager.kill(readTerminalOnly(params, 'terminal kill'))
			return {}
		},
		[TERMINAL_METHODS.close]: async (params: Record<string, unknown>) => {
			await manager.close(readTerminalOnly(params, 'terminal close'))
			return {}
		},
	}
	return { extensions, manager, close: () => manager.closeAll() }
}
