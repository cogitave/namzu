/**
 * What the Namzu host says about its terminals, read before anything trusts it.
 *
 * The host process owns every pseudo-terminal; the desktop is a view. This is the
 * desktop half of `packages/cli/src/terminal/protocol.ts`: it validates what the
 * host answers and announces, and holds the names and limits the desktop sends
 * under. Keep the two files aligned; `terminal-protocol.test.ts` fails when a
 * method name or a limit drifts.
 *
 * Offsets count UTF-16 code units of all output ever printed and only grow.
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
	maxTerminals: 16,
	maxCols: 500,
	maxRows: 200,
	maxWrite: 65_536,
	maxChunk: 16_384,
	ringCapacity: 1_048_576,
	maxScreen: 2_097_152,
	maxCommand: 4_096,
	maxArgs: 256,
	maxArg: 32_768,
	maxEnv: 256,
	maxTitle: 200,
	maxViewerId: 128,
} as const

export interface TerminalInfo {
	id: string
	pid: number
	title: string
	cwd: string
	command: string
	args: string[]
	cols: number
	rows: number
	status: 'running' | 'exited'
	exitCode?: number
	signal?: number
	createdAt: number
	offset: number
	writerHeld: boolean
}

export interface TerminalStatus {
	available: boolean
	reason?: string
	platform: string
	limits: {
		maxTerminals: number
		maxCols: number
		maxRows: number
		maxWrite: number
		maxChunk: number
	}
}

export interface TerminalAttachResult {
	terminal: TerminalInfo
	mode: 'replay' | 'snapshot'
	screen: string
	data: string
	start: number
	end: number
	writer: boolean
	truncated: boolean
}

export interface TerminalDataNotification {
	terminalId: string
	offset: number
	data: string
}

export interface TerminalExitNotification {
	terminalId: string
	exitCode: number
	signal?: number
}

/** What the desktop asks the host to start. */
export interface TerminalCreateSpec {
	cwd?: string
	command?: string
	args?: string[]
	/** A value sets the variable; null removes it from the host's own environment. */
	env?: Record<string, string | null>
	cols: number
	rows: number
	title?: string
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function object(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`Invalid terminal ${what}.`)
	return value as Record<string, unknown>
}
function known(record: Record<string, unknown>, fields: readonly string[], what: string): void {
	for (const key of Object.keys(record))
		if (!fields.includes(key)) throw new Error(`Unexpected terminal ${what} field: ${key}.`)
}
function text(
	value: unknown,
	what: string,
	max: number,
	options: { empty?: boolean } = {},
): string {
	if (typeof value !== 'string' || (!options.empty && value.length === 0) || value.length > max)
		throw new Error(`Invalid terminal ${what}.`)
	return value
}
function integer(value: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error(`Invalid terminal ${what}.`)
	return value
}
function flag(value: unknown, what: string): boolean {
	if (typeof value !== 'boolean') throw new Error(`Invalid terminal ${what}.`)
	return value
}
export function readTerminalId(value: unknown): string {
	if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid terminal id.')
	return value
}

export function readTerminalInfo(value: unknown): TerminalInfo {
	const record = object(value, 'description')
	known(
		record,
		[
			'id',
			'pid',
			'title',
			'cwd',
			'command',
			'args',
			'cols',
			'rows',
			'status',
			'exitCode',
			'signal',
			'createdAt',
			'offset',
			'writerHeld',
		],
		'description',
	)
	if (record.status !== 'running' && record.status !== 'exited')
		throw new Error('Invalid terminal status.')
	if (!Array.isArray(record.args) || record.args.length > TERMINAL_LIMITS.maxArgs)
		throw new Error('Invalid terminal arguments.')
	return {
		id: readTerminalId(record.id),
		pid: integer(record.pid, 'process id'),
		title: text(record.title, 'title', TERMINAL_LIMITS.maxTitle, { empty: true }),
		cwd: text(record.cwd, 'folder', 32_768),
		command: text(record.command, 'command', TERMINAL_LIMITS.maxCommand),
		args: record.args.map((arg) => text(arg, 'argument', TERMINAL_LIMITS.maxArg, { empty: true })),
		cols: integer(record.cols, 'columns', 1, TERMINAL_LIMITS.maxCols),
		rows: integer(record.rows, 'rows', 1, TERMINAL_LIMITS.maxRows),
		status: record.status,
		...(record.exitCode === undefined
			? {}
			: { exitCode: integer(record.exitCode, 'exit code', -2_147_483_648, 4_294_967_295) }),
		...(record.signal === undefined ? {} : { signal: integer(record.signal, 'signal', 0, 255) }),
		createdAt: integer(record.createdAt, 'creation time'),
		offset: integer(record.offset, 'offset'),
		writerHeld: flag(record.writerHeld, 'keyboard state'),
	}
}

export function readTerminalStatus(value: unknown): TerminalStatus {
	const record = object(value, 'status')
	known(record, ['available', 'reason', 'platform', 'limits'], 'status')
	const limits = object(record.limits, 'limits')
	return {
		available: flag(record.available, 'availability'),
		...(record.reason === undefined ? {} : { reason: text(record.reason, 'reason', 4_000) }),
		platform: text(record.platform, 'platform', 64),
		limits: {
			maxTerminals: integer(limits.maxTerminals, 'limit', 1, 1_000),
			maxCols: integer(limits.maxCols, 'limit', 1, 10_000),
			maxRows: integer(limits.maxRows, 'limit', 1, 10_000),
			maxWrite: integer(limits.maxWrite, 'limit', 1, 10_000_000),
			maxChunk: integer(limits.maxChunk, 'limit', 1, 10_000_000),
		},
	}
}

export function readTerminalCreated(value: unknown): TerminalInfo {
	const record = object(value, 'creation')
	known(record, ['terminal'], 'creation')
	return readTerminalInfo(record.terminal)
}

export function readTerminalList(value: unknown): TerminalInfo[] {
	const record = object(value, 'list')
	known(record, ['terminals'], 'list')
	if (!Array.isArray(record.terminals) || record.terminals.length > TERMINAL_LIMITS.maxTerminals)
		throw new Error('Invalid terminal list.')
	const terminals = record.terminals.map(readTerminalInfo)
	if (new Set(terminals.map((terminal) => terminal.id)).size !== terminals.length)
		throw new Error('Duplicate terminal in list.')
	return terminals
}

export function readTerminalAttach(value: unknown): TerminalAttachResult {
	const record = object(value, 'attachment')
	known(
		record,
		['terminal', 'mode', 'screen', 'data', 'start', 'end', 'writer', 'truncated'],
		'attachment',
	)
	if (record.mode !== 'replay' && record.mode !== 'snapshot')
		throw new Error('Invalid terminal mode.')
	const screen = text(record.screen, 'screen', TERMINAL_LIMITS.maxScreen, { empty: true })
	const data = text(record.data, 'output', TERMINAL_LIMITS.ringCapacity, { empty: true })
	const start = integer(record.start, 'start offset')
	const end = integer(record.end, 'end offset')
	if (start + data.length !== end) throw new Error('Terminal output does not match its offsets.')
	if (record.mode === 'replay' && screen !== '') throw new Error('A replay carries no screen.')
	return {
		terminal: readTerminalInfo(record.terminal),
		mode: record.mode,
		screen,
		data,
		start,
		end,
		writer: flag(record.writer, 'keyboard state'),
		truncated: flag(record.truncated, 'truncation'),
	}
}

export function readTerminalData(value: unknown): TerminalDataNotification {
	const record = object(value, 'output')
	known(record, ['terminalId', 'offset', 'data'], 'output')
	return {
		terminalId: readTerminalId(record.terminalId),
		offset: integer(record.offset, 'offset'),
		data: text(record.data, 'output', TERMINAL_LIMITS.maxChunk),
	}
}

export function readTerminalExit(value: unknown): TerminalExitNotification {
	const record = object(value, 'exit')
	known(record, ['terminalId', 'exitCode', 'signal'], 'exit')
	return {
		terminalId: readTerminalId(record.terminalId),
		exitCode: integer(record.exitCode, 'exit code', -2_147_483_648, 4_294_967_295),
		...(record.signal === undefined ? {} : { signal: integer(record.signal, 'signal', 0, 255) }),
	}
}

/** The create request the host will accept, or the reason it would not. */
export function checkTerminalCreate(spec: TerminalCreateSpec): TerminalCreateSpec {
	integer(spec.cols, 'columns', 1, TERMINAL_LIMITS.maxCols)
	integer(spec.rows, 'rows', 1, TERMINAL_LIMITS.maxRows)
	if (spec.command !== undefined) text(spec.command, 'command', TERMINAL_LIMITS.maxCommand)
	if (spec.title !== undefined) text(spec.title, 'title', TERMINAL_LIMITS.maxTitle)
	if (spec.cwd !== undefined) text(spec.cwd, 'folder', 32_768)
	if (spec.args !== undefined) {
		if (spec.args.length > TERMINAL_LIMITS.maxArgs) throw new Error('Too many terminal arguments.')
		for (const arg of spec.args) text(arg, 'argument', TERMINAL_LIMITS.maxArg, { empty: true })
	}
	if (spec.env !== undefined) {
		const entries = Object.entries(spec.env)
		if (entries.length > TERMINAL_LIMITS.maxEnv) throw new Error('Too many terminal variables.')
		for (const [name, entry] of entries) {
			if (!name || name.includes('=') || name.includes('\0'))
				throw new Error('Invalid terminal variable.')
			if (entry !== null) text(entry, 'variable', 32_768, { empty: true })
		}
	}
	return spec
}
