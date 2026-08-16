import { type ChildProcess, spawn } from 'node:child_process'
import type {
	MCPJsonRpcMessage,
	MCPStdioTransportConfig,
	MCPTransport,
} from '../../types/connector/index.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'

/**
 * How long a child gets to honour SIGTERM before SIGKILL. Two seconds is
 * long enough for a server flushing a response and short enough that a
 * shutdown does not read as a hang.
 */
const TERMINATE_GRACE_MS = 2_000

/**
 * The variables a child needs in order to be a working process at all.
 *
 * This spawn used to pass `{ ...process.env, ...config.env }`, so a connected
 * server received every credential the host happened to hold — measured at 119
 * variables on a developer machine, including a planted secret the server had
 * no reason to see. A server that needs one token was handed all of them, and
 * nothing in the config said so.
 *
 * The list below is process plumbing, not secrets: where to find executables,
 * where the home and temp directories are, what the locale is. Dropping any of
 * it does not harden anything and does break servers — a child with no `PATH`
 * cannot resolve its own interpreter.
 *
 * Anything else a server needs is now named: `env` gives it a literal value,
 * and `inheritEnv` names a parent variable to pass through. Naming is the
 * point — a grant that has to be written down is a grant somebody can review.
 *
 * Windows spellings are matched case-insensitively, because its environment is
 * case-insensitive and a lookup for `Path` against a key stored as `PATH` would
 * silently drop it — which would present as "the server does not start on
 * Windows" rather than as anything to do with this list.
 */
const BASE_ENV_KEYS: readonly string[] = [
	// Everywhere.
	'PATH',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'TZ',
	// POSIX.
	'HOME',
	'SHELL',
	'TMPDIR',
	'USER',
	'LOGNAME',
	// Windows. `SystemRoot` and `ComSpec` are load-bearing: without them a
	// child cannot resolve system DLLs or the command interpreter.
	'PATHEXT',
	'SystemRoot',
	'SystemDrive',
	'ComSpec',
	'WINDIR',
	'TEMP',
	'TMP',
	'USERPROFILE',
	'HOMEDRIVE',
	'HOMEPATH',
	'APPDATA',
	'LOCALAPPDATA',
	'PROGRAMDATA',
	'PROGRAMFILES',
	'NUMBER_OF_PROCESSORS',
	'PROCESSOR_ARCHITECTURE',
]

/**
 * Read one variable from the parent, honouring the platform's own casing rules.
 *
 * Node exposes `process.env` on Windows through a case-insensitive proxy, so a
 * direct lookup already works there — but the KEY this returns has to be the
 * one the parent actually uses, or a child comparing key names sees a spelling
 * the host never set.
 */
function readParentVar(source: NodeJS.ProcessEnv, name: string): [string, string] | undefined {
	const direct = source[name]
	if (direct !== undefined) return [name, direct]
	if (process.platform !== 'win32') return undefined
	const lowered = name.toLowerCase()
	for (const [key, value] of Object.entries(source)) {
		if (key.toLowerCase() === lowered && value !== undefined) return [key, value]
	}
	return undefined
}

/**
 * What the child is handed: plumbing, then the named inheritances, then the
 * literal values.
 *
 * Later wins, and the order is the precedence an operator would guess: a
 * literal `env` entry overrides an inherited one, and both override the base.
 * Exported for the tests, which assert on the ENV rather than on the spawn —
 * a test that only checked the config was accepted would have passed against
 * the version this replaces.
 */
export function buildChildEnv(
	config: Pick<MCPStdioTransportConfig, 'env' | 'inheritEnv'>,
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {}
	for (const name of BASE_ENV_KEYS) {
		const found = readParentVar(source, name)
		if (found) env[found[0]] = found[1]
	}
	for (const name of config.inheritEnv ?? []) {
		const found = readParentVar(source, name)
		// A named variable the parent does not hold is simply absent. Refusing
		// the spawn would turn an optional credential into a startup failure,
		// and inventing an empty string would tell the server it has one.
		if (found) env[found[0]] = found[1]
	}
	for (const [name, value] of Object.entries(config.env ?? {})) env[name] = value
	return env
}

export class StdioTransport implements MCPTransport {
	private process: ChildProcess | null = null
	private messageHandlers: Array<(message: MCPJsonRpcMessage) => void> = []
	private closeHandlers: Array<() => void> = []
	private errorHandlers: Array<(error: Error) => void> = []
	private connected = false
	/** True between kill and the process's own `close` event. */
	private exitPending = false
	private buffer = ''
	private log: Logger

	constructor(
		private readonly config: MCPStdioTransportConfig,
		log?: Logger,
	) {
		this.log = resolveLogger(log).child({ component: 'StdioTransport' })
	}

	async connect(): Promise<void> {
		if (this.connected) return

		this.process = spawn(this.config.command, this.config.args ?? [], {
			env: buildChildEnv(this.config),
			cwd: this.config.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		})

		this.process.stdout?.on('data', (chunk: Buffer) => {
			this.buffer += chunk.toString('utf-8')
			this.processBuffer()
		})

		this.process.stderr?.on('data', (chunk: Buffer) => {
			this.log.warn('MCP server stderr', {
				'namzu.mcp.stderr': chunk.toString('utf-8').trim(),
			})
		})

		this.process.on('close', (code) => {
			this.connected = false
			this.log.info('MCP server process exited', { 'namzu.mcp.exit_code': code })
			for (const handler of this.closeHandlers) handler()
			// After the notification, not before it: this event is what tells
			// `MCPClient` the session ended.
			this.exitPending = false
			this.clearHandlers()
		})

		this.process.on('error', (err) => {
			this.connected = false
			for (const handler of this.errorHandlers) handler(err)
		})

		this.connected = true
		this.log.info('StdioTransport connected', {
			'namzu.mcp.command': this.config.command,
			'namzu.mcp.args': (this.config.args ?? []).join(' '),
		})
	}

	async close(): Promise<void> {
		if (!this.process) {
			// Nothing was spawned, or the exit already ran. No `close` event is
			// coming, so this is the only chance to drop what `connect()`
			// registered — and without it a retry after a failed spawn stacks a
			// second set of handlers on the first.
			if (!this.exitPending) this.clearHandlers()
			return
		}
		this.connected = false
		this.exitPending = true
		const child = this.process
		this.process = null
		this.buffer = ''

		// Resolve when the child is actually gone, not when the signal was
		// sent. `kill()` returns as soon as the signal is delivered, so an
		// awaited `close()` meant only "SIGTERM is on its way" — a caller that
		// closed and then deleted the child's working directory raced the exit
		// and saw EBUSY. A close that does not mean closed makes every
		// teardown after it a guess.
		//
		// A spawn that never produced a process emits `error` and no `exit`,
		// so both settle this, and two timers make a hang impossible: the
		// first escalates to SIGKILL for a child ignoring SIGTERM, the second
		// gives up waiting. Neither holds the event loop open.
		if (child.pid === undefined) return
		await new Promise<void>((resolve) => {
			let settled = false
			const finish = (): void => {
				if (settled) return
				settled = true
				clearTimeout(escalate)
				clearTimeout(giveUp)
				resolve()
			}
			child.once('exit', finish)
			child.once('error', finish)
			child.kill('SIGTERM')
			const escalate = setTimeout(() => child.kill('SIGKILL'), TERMINATE_GRACE_MS)
			const giveUp = setTimeout(finish, TERMINATE_GRACE_MS * 2)
			escalate.unref?.()
			giveUp.unref?.()
		})
		// The handlers deliberately survive this call. `process.on('close')`
		// fires them when the process actually exits, and dropping them here
		// would leave `MCPClient` believing it is still connected — so its next
		// `connect()` would be refused with "already connected".
	}

	/**
	 * Drop every registered handler.
	 *
	 * `onMessage`/`onClose`/`onError` append, and `MCPClient.connect()` calls
	 * all three every time — and is reachable again after `disconnect()`. So
	 * without this each reconnect duplicated the set, and after n cycles one
	 * inbound message dispatched to n handlers, n-1 of them closures over dead
	 * sessions that kept their old client state alive.
	 */
	private clearHandlers(): void {
		this.messageHandlers = []
		this.closeHandlers = []
		this.errorHandlers = []
	}

	async send(message: MCPJsonRpcMessage): Promise<void> {
		if (!this.process?.stdin?.writable) {
			throw new Error('StdioTransport: not connected or stdin not writable')
		}
		const data = `${JSON.stringify(message)}\n`
		this.process.stdin.write(data)
	}

	onMessage(handler: (message: MCPJsonRpcMessage) => void): void {
		this.messageHandlers.push(handler)
	}

	onClose(handler: () => void): void {
		this.closeHandlers.push(handler)
	}

	onError(handler: (error: Error) => void): void {
		this.errorHandlers.push(handler)
	}

	isConnected(): boolean {
		return this.connected
	}

	private processBuffer(): void {
		const lines = this.buffer.split('\n')
		this.buffer = lines.pop() ?? ''

		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue
			try {
				const message = JSON.parse(trimmed) as MCPJsonRpcMessage
				for (const handler of this.messageHandlers) handler(message)
			} catch {
				this.log.warn('StdioTransport: invalid JSON-RPC message', {
					'namzu.mcp.message_head': trimmed.slice(0, 100),
				})
			}
		}
	}
}
