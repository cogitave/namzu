import { type ChildProcess, spawn } from 'node:child_process'
import type {
	MCPJsonRpcMessage,
	MCPStdioTransportConfig,
	MCPTransport,
	MCPTransportSendOptions,
} from '../../types/connector/index.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import {
	WINDOWS_CORE_ENV_KEYS,
	applyEnvironmentOverrides,
	pickEnvironmentEntries,
	readEnvironmentEntry,
	setEnvironmentEntry,
} from '../../utils/process-environment.js'

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
	// Windows. `SystemRoot`, `ComSpec` and `WINDIR` are load-bearing: without
	// them a child cannot resolve system DLLs or the command interpreter.
	...WINDOWS_CORE_ENV_KEYS,
]

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
	const env = pickEnvironmentEntries(BASE_ENV_KEYS, source)
	for (const name of config.inheritEnv ?? []) {
		const found = readEnvironmentEntry(source, name)
		// A named variable the parent does not hold is simply absent. Refusing
		// the spawn would turn an optional credential into a startup failure,
		// and inventing an empty string would tell the server it has one.
		if (found) setEnvironmentEntry(env, found[0], found[1])
	}
	applyEnvironmentOverrides(env, config.env)
	return env
}

export class StdioTransport implements MCPTransport {
	private process: ChildProcess | null = null
	private messageHandlers: Array<(message: MCPJsonRpcMessage) => void> = []
	private closeHandlers: Array<() => void> = []
	private errorHandlers: Array<(error: Error) => void> = []
	private connected = false
	/** The response channel ended for this process generation. */
	private retired = false
	/** Prevents a late event from an old child retiring its replacement. */
	private generation = 0
	/** True between kill and the process's own `close` event. */
	private exitPending = false
	private buffer = ''
	private log: Logger

	constructor(
		private readonly config: MCPStdioTransportConfig,
		log?: Logger,
	) {
		this.log = resolveLogger(log).child({ [SCOPE_ATTRIBUTE]: 'connector/mcp/stdio' })
	}

	async connect(): Promise<void> {
		if (this.connected) return
		// A protocol channel can end while its process stays alive. Reconnect
		// must reap that old owner before publishing a new generation; otherwise
		// both children remain live and teardown owns only the newest one.
		if (this.process) await this.close()
		const generation = ++this.generation
		this.retired = false
		this.buffer = ''

		const child = spawn(this.config.command, this.config.args ?? [], {
			env: buildChildEnv(this.config),
			cwd: this.config.cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		this.process = child

		child.stdout?.on('data', (chunk: Buffer) => {
			if (generation !== this.generation || this.retired) return
			this.buffer += chunk.toString('utf-8')
			this.processBuffer()
		})
		child.stdout?.once('end', () => this.retire(generation, 'close'))
		child.stdout?.once('close', () => this.retire(generation, 'close'))
		child.stdout?.once('error', (err) => this.retire(generation, 'error', err))

		child.stderr?.on('data', (chunk: Buffer) => {
			this.log.warn('MCP server stderr', {
				'namzu.mcp.stderr': chunk.toString('utf-8').trim(),
			})
		})

		child.stdin?.once('close', () => this.retire(generation, 'close'))
		child.stdin?.once('error', (err) => this.retire(generation, 'error', err))

		child.on('close', (code) => {
			if (this.process === child) this.process = null
			this.exitPending = false
			this.log.info('MCP server process exited', { 'namzu.mcp.exit_code': code })
			this.retire(generation, 'close')
		})

		child.on('error', (err) => this.retire(generation, 'error', err))

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
		if (child.pid === undefined) {
			this.exitPending = false
			return
		}
		await new Promise<void>((resolve) => {
			let settled = false
			const finish = (): void => {
				if (settled) return
				settled = true
				clearTimeout(escalate)
				clearTimeout(giveUp)
				resolve()
			}
			child.once('close', finish)
			child.once('error', finish)
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGTERM')
			}
			const escalate = setTimeout(() => child.kill('SIGKILL'), TERMINATE_GRACE_MS)
			const giveUp = setTimeout(finish, TERMINATE_GRACE_MS * 2)
			escalate.unref?.()
			giveUp.unref?.()
		})
		this.exitPending = false
		// The active generation's terminal stream/process event owns handler
		// retirement. A reconnect can register its handlers before `connect()`
		// reaps an already-retired child, so `close()` must not clear them here.
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

	/**
	 * Publish one terminal result for the current response channel.
	 *
	 * A child may close stdout and keep running. That is just as terminal for
	 * JSON-RPC as process exit: no pending or future request can receive a
	 * response. Keeping the child handle is intentional; `close()` still owns
	 * and reaps that process after the protocol session has been retired.
	 */
	private retire(generation: number, kind: 'close' | 'error', error?: Error): void {
		if (generation !== this.generation || this.retired) return
		this.retired = true
		this.connected = false
		this.buffer = ''
		const closeHandlers = this.closeHandlers
		const errorHandlers = this.errorHandlers
		this.clearHandlers()
		if (kind === 'error') {
			const reason = error ?? new Error('MCP stdio transport failed')
			for (const handler of errorHandlers) handler(reason)
			return
		}
		for (const handler of closeHandlers) handler()
	}

	async send(message: MCPJsonRpcMessage, options?: MCPTransportSendOptions): Promise<void> {
		options?.signal?.throwIfAborted()
		if (!this.process?.stdin?.writable) {
			throw new Error('StdioTransport: not connected or stdin not writable')
		}
		// No await lies between the checks and write, so a standard AbortSignal
		// cannot change in this interval. Once written, MCP protocol
		// `notifications/cancelled` is the cooperative cancellation mechanism.
		options?.signal?.throwIfAborted()
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
