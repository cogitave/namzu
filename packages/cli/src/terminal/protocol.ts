/**
 * The wire shape of the host terminal, over the desktop connection.
 *
 * The CLI host process owns every pseudo-terminal; the desktop application is a
 * view. Requests are `namzu/terminal/*` extension methods and output travels back
 * as two notifications. Both ends validate: this module reads what a client may
 * ask for, and `packages/desktop/src/shared/terminal-protocol.ts` reads what the
 * host answers and announces. The two files describe one closed shape and a test
 * in the desktop package fails when their method names or limits drift.
 *
 * Offsets count UTF-16 code units of everything the program ever printed. They
 * only grow, so a viewer that remembers the last offset it drew can ask for
 * exactly what it missed, and a notification it has already drawn is recognisable
 * and dropped.
 */

export const TERMINAL_METHODS = {
	status: 'namzu/terminal/status',
	create: 'namzu/terminal/create',
	list: 'namzu/terminal/list',
	attach: 'namzu/terminal/attach',
	detach: 'namzu/terminal/detach',
	write: 'namzu/terminal/write',
	resize: 'namzu/terminal/resize',
	ack: 'namzu/terminal/ack',
	kill: 'namzu/terminal/kill',
	close: 'namzu/terminal/close',
} as const

export const TERMINAL_NOTIFICATIONS = {
	data: 'namzu/terminal/data',
	exit: 'namzu/terminal/exit',
} as const

export const TERMINAL_LIMITS = {
	/** Live and ended terminals one host keeps. */
	maxTerminals: 16,
	maxCols: 500,
	maxRows: 200,
	/** Characters one write request may carry. */
	maxWrite: 65_536,
	/** Characters one data notification may carry. */
	maxChunk: 16_384,
	/** Output the host keeps per terminal for replay. */
	ringCapacity: 1_048_576,
	/** Unacknowledged output at which the program is paused. */
	flowHigh: 524_288,
	/** Unacknowledged output at which a paused program resumes. */
	flowLow: 131_072,
	/** Scrollback rows a snapshot carries. */
	snapshotScrollback: 1_000,
	/** Scrollback rows the host's own screen keeps. */
	screenScrollback: 5_000,
	/** Largest serialized screen an attach result may carry. */
	maxScreen: 2_097_152,
	maxCommand: 4_096,
	maxArgs: 256,
	maxArg: 32_768,
	maxEnv: 256,
	maxTitle: 200,
	maxViewerId: 128,
} as const

export interface TerminalInfo {
	readonly id: string
	/** The program's process id; 0 when the binding does not report one. */
	readonly pid: number
	readonly title: string
	readonly cwd: string
	readonly command: string
	readonly args: readonly string[]
	readonly cols: number
	readonly rows: number
	readonly status: 'running' | 'exited'
	readonly exitCode?: number
	readonly signal?: number
	readonly createdAt: number
	/** Total output so far; the offset the next chunk starts at. */
	readonly offset: number
	/** Whether some view currently holds the keyboard. */
	readonly writerHeld: boolean
}

export interface TerminalStatus {
	readonly available: boolean
	/** Why not, in words an operator can act on. */
	readonly reason?: string
	readonly platform: string
	readonly limits: {
		readonly maxTerminals: number
		readonly maxCols: number
		readonly maxRows: number
		readonly maxWrite: number
		readonly maxChunk: number
	}
}

export interface TerminalAttachResult {
	readonly terminal: TerminalInfo
	/**
	 * `replay`: the viewer keeps what it drew and appends `data` (which starts at
	 * its own offset). `snapshot`: the viewer resets, writes `screen`, then `data`.
	 */
	readonly mode: 'replay' | 'snapshot'
	readonly screen: string
	readonly data: string
	/** Offset of the first character of `data`. */
	readonly start: number
	/** Offset after the last character of `data`; live notifications continue here. */
	readonly end: number
	/** Whether this view holds the keyboard. */
	readonly writer: boolean
	/** True when the host could not reach back far enough to be exact. */
	readonly truncated: boolean
}

export interface TerminalDataNotification {
	readonly terminalId: string
	readonly offset: number
	readonly data: string
}

export interface TerminalExitNotification {
	readonly terminalId: string
	readonly exitCode: number
	readonly signal?: number
}

export class TerminalRequestError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'TerminalRequestError'
	}
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function record(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TerminalRequestError(`Invalid ${what} request.`)
	return value as Record<string, unknown>
}

function exact(params: Record<string, unknown>, allowed: readonly string[], what: string): void {
	for (const key of Object.keys(params))
		if (!allowed.includes(key)) throw new TerminalRequestError(`Unexpected ${what} field: ${key}.`)
}

function text(
	params: Record<string, unknown>,
	key: string,
	max: number,
	options: { empty?: boolean } = {},
): string {
	const value = params[key]
	if (
		typeof value !== 'string' ||
		(!options.empty && value.length === 0) ||
		value.length > max ||
		value.includes('\0')
	)
		throw new TerminalRequestError(`Invalid ${key}.`)
	return value
}

function integer(params: Record<string, unknown>, key: string, min: number, max: number): number {
	const value = params[key]
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
		throw new TerminalRequestError(`Invalid ${key}.`)
	return value
}

export function terminalId(params: Record<string, unknown>): string {
	const value = params.terminalId
	if (typeof value !== 'string' || !ID.test(value))
		throw new TerminalRequestError('Invalid terminalId.')
	return value
}

function viewerId(params: Record<string, unknown>): string {
	const value = text(params, 'viewerId', TERMINAL_LIMITS.maxViewerId)
	if (!/^[\w.:-]+$/u.test(value)) throw new TerminalRequestError('Invalid viewerId.')
	return value
}

function size(params: Record<string, unknown>): { cols: number; rows: number } {
	return {
		cols: integer(params, 'cols', 1, TERMINAL_LIMITS.maxCols),
		rows: integer(params, 'rows', 1, TERMINAL_LIMITS.maxRows),
	}
}

export interface CreateRequest {
	readonly cwd?: string
	readonly command?: string
	readonly args: readonly string[]
	/** A value sets the variable; null removes it from the inherited environment. */
	readonly env: Readonly<Record<string, string | null>>
	readonly cols: number
	readonly rows: number
	readonly title?: string
}

const ENV_NAME = /^[^=\0\s][^=\0]*$/u

export function readCreate(raw: unknown): CreateRequest {
	const params = record(raw, 'terminal create')
	exact(params, ['cwd', 'command', 'args', 'env', 'cols', 'rows', 'title'], 'terminal create')
	const args: string[] = []
	if (params.args !== undefined) {
		if (!Array.isArray(params.args) || params.args.length > TERMINAL_LIMITS.maxArgs)
			throw new TerminalRequestError('Invalid args.')
		for (const arg of params.args) {
			if (typeof arg !== 'string' || arg.length > TERMINAL_LIMITS.maxArg || arg.includes('\0'))
				throw new TerminalRequestError('Invalid args.')
			args.push(arg)
		}
	}
	const env: Record<string, string | null> = Object.create(null)
	if (params.env !== undefined) {
		const entries = Object.entries(record(params.env, 'terminal env'))
		if (entries.length > TERMINAL_LIMITS.maxEnv) throw new TerminalRequestError('Invalid env.')
		for (const [name, value] of entries) {
			if (
				name.length > 512 ||
				!ENV_NAME.test(name) ||
				(value !== null &&
					(typeof value !== 'string' || value.length > 32_768 || value.includes('\0')))
			)
				throw new TerminalRequestError('Invalid env.')
			env[name] = value as string | null
		}
	}
	return {
		...(params.cwd === undefined ? {} : { cwd: text(params, 'cwd', 32_768) }),
		...(params.command === undefined
			? {}
			: { command: text(params, 'command', TERMINAL_LIMITS.maxCommand) }),
		args,
		env,
		...size(params),
		...(params.title === undefined
			? {}
			: { title: text(params, 'title', TERMINAL_LIMITS.maxTitle) }),
	}
}

export function readTerminalOnly(raw: unknown, what: string): string {
	const params = record(raw, what)
	exact(params, ['terminalId'], what)
	return terminalId(params)
}

export function readAttach(raw: unknown): {
	terminalId: string
	viewerId: string
	fromOffset?: number
	writer: boolean
	force: boolean
} {
	const params = record(raw, 'terminal attach')
	exact(params, ['terminalId', 'viewerId', 'fromOffset', 'writer', 'force'], 'terminal attach')
	for (const key of ['writer', 'force'])
		if (params[key] !== undefined && typeof params[key] !== 'boolean')
			throw new TerminalRequestError(`Invalid ${key}.`)
	return {
		terminalId: terminalId(params),
		viewerId: viewerId(params),
		...(params.fromOffset === undefined
			? {}
			: { fromOffset: integer(params, 'fromOffset', 0, Number.MAX_SAFE_INTEGER) }),
		writer: params.writer === true,
		force: params.force === true,
	}
}

export function readDetach(raw: unknown): { terminalId: string; viewerId: string } {
	const params = record(raw, 'terminal detach')
	exact(params, ['terminalId', 'viewerId'], 'terminal detach')
	return { terminalId: terminalId(params), viewerId: viewerId(params) }
}

export function readWrite(raw: unknown): { terminalId: string; viewerId: string; data: string } {
	const params = record(raw, 'terminal write')
	exact(params, ['terminalId', 'viewerId', 'data'], 'terminal write')
	return {
		terminalId: terminalId(params),
		viewerId: viewerId(params),
		// Keystrokes include NUL (Ctrl+Space), which a path or a name may not.
		data: keystrokes(params.data),
	}
}

function keystrokes(value: unknown): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > TERMINAL_LIMITS.maxWrite)
		throw new TerminalRequestError('Invalid data.')
	return value
}

export function readResize(raw: unknown): {
	terminalId: string
	viewerId: string
	cols: number
	rows: number
} {
	const params = record(raw, 'terminal resize')
	exact(params, ['terminalId', 'viewerId', 'cols', 'rows'], 'terminal resize')
	return { terminalId: terminalId(params), viewerId: viewerId(params), ...size(params) }
}

export function readAck(raw: unknown): { terminalId: string; offset: number } {
	const params = record(raw, 'terminal ack')
	exact(params, ['terminalId', 'offset'], 'terminal ack')
	return {
		terminalId: terminalId(params),
		offset: integer(params, 'offset', 0, Number.MAX_SAFE_INTEGER),
	}
}
