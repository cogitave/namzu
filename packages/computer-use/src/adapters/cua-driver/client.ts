import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { SpawnError } from '../../util/spawn.js'

/**
 * A client for one MCP server spoken to over a child process's standard
 * streams: newline-delimited JSON-RPC 2.0, as the MCP stdio transport
 * defines it. It owns the process:
 *
 * - started lazily on the first call, with the `initialize` handshake;
 * - restarted by the next call after it exits or is killed;
 * - killed when a request outlives its timeout, because a server that has
 *   stopped answering one request cannot be trusted with the next;
 * - asked to exit (stdin closed) and then killed on {@link dispose}.
 *
 * A request that was written and then lost to an exit or a timeout rejects
 * with {@link SpawnError}, the same "it started and did not finish cleanly"
 * signal the one-shot subprocess adapters give; the host turns that into an
 * unknown outcome for actions that change the desktop. A failure before
 * anything was sent — the process would not start, the handshake failed —
 * is an ordinary `Error`.
 */

export type McpContent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image'; readonly data: string; readonly mimeType: string }
	| { readonly type: string; readonly [key: string]: unknown }

export interface McpToolResult {
	readonly content: readonly McpContent[]
	readonly structuredContent?: Record<string, unknown>
}

/** A tool refusal from the server, or a local pre-dispatch UI snapshot guard. */
export class McpToolError extends Error {
	override readonly name = 'McpToolError'

	constructor(
		readonly tool: string,
		message: string,
		readonly structuredContent?: Record<string, unknown>,
	) {
		super(message)
	}
}

/** The server answered a request with a JSON-RPC error. */
export class McpProtocolError extends Error {
	override readonly name = 'McpProtocolError'

	constructor(
		readonly method: string,
		readonly code: number,
		message: string,
	) {
		super(`${method} failed (${code}): ${message}`)
	}
}

export type McpToolCaller = (
	name: string,
	args?: Record<string, unknown>,
	timeoutMs?: number,
) => Promise<McpToolResult>

export interface McpProcessCallOptions {
	/** Refuse before dispatch if a UI token came from another driver process. */
	readonly expectedStarts?: number
	/** Record the process that actually received this call. */
	readonly onProcess?: (starts: number) => void
}

export interface McpStdioClientOptions {
	readonly command: string
	readonly args: readonly string[]
	readonly env?: NodeJS.ProcessEnv
	readonly cwd?: string
	readonly clientName?: string
	readonly clientVersion?: string
	/** Default `2025-06-18`. */
	readonly protocolVersion?: string
	/** Spawn plus `initialize`. Default 20 s. */
	readonly startTimeoutMs?: number
	/** Default per-request timeout. Default 15 s. */
	readonly requestTimeoutMs?: number
	/** Runs once per started process, after `initialize`, before any caller's request. */
	readonly afterStart?: (call: McpToolCaller) => Promise<void>
	/** For tests: start something other than `command`. */
	readonly spawnProcess?: (
		command: string,
		args: readonly string[],
		options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string },
	) => ChildProcessWithoutNullStreams
}

interface Pending {
	readonly method: string
	readonly resolve: (value: unknown) => void
	readonly reject: (error: Error) => void
	readonly timer: NodeJS.Timeout
}

interface Running {
	readonly child: ChildProcessWithoutNullStreams
	readonly startOrdinal: number
	readonly pending: Map<number, Pending>
	readonly stderr: string[]
	exited: boolean
	/** Set when this client killed it, so the rejection says why. */
	killedFor?: 'timeout' | 'dispose'
	readonly closed: Promise<void>
}

const STDERR_TAIL_BYTES = 4_000

export class McpStdioClient {
	private running: Running | undefined
	private starting: Promise<Running> | undefined
	private nextId = 1
	private disposed = false
	private startCount = 0

	constructor(private readonly options: McpStdioClientOptions) {}

	/** How many processes this client has started; a restart counts again. */
	get starts(): number {
		return this.startCount
	}

	/** The running process's id on this side, if one is running. */
	get pid(): number | undefined {
		return this.running && !this.running.exited ? this.running.child.pid : undefined
	}

	/** Start the server now, rather than on the first call. */
	async start(): Promise<void> {
		await this.ensureStarted()
	}

	/** Call one tool. Rejects with {@link McpToolError} when the server says the tool failed. */
	async callTool(
		name: string,
		args: Record<string, unknown> = {},
		timeoutMs?: number,
		process?: McpProcessCallOptions,
	): Promise<McpToolResult> {
		const running = await this.ensureStarted()
		if (process?.expectedStarts !== undefined && process.expectedStarts !== running.startOrdinal)
			throw new McpToolError(name, 'stale UI snapshot; take a new one')
		process?.onProcess?.(running.startOrdinal)
		return this.callOn(running, name, args, timeoutMs)
	}

	async dispose(): Promise<void> {
		this.disposed = true
		const running = this.running ?? (await this.starting?.catch(() => undefined))
		if (!running || running.exited) return
		running.killedFor = 'dispose'
		running.child.stdin.end()
		let timer: NodeJS.Timeout | undefined
		const late = new Promise<'late'>((resolve) => {
			timer = setTimeout(() => resolve('late'), 2_000)
		})
		const outcome = await Promise.race([running.closed.then(() => 'closed' as const), late])
		clearTimeout(timer)
		if (outcome === 'late') {
			running.child.kill('SIGKILL')
			await running.closed
		}
	}

	private async ensureStarted(): Promise<Running> {
		if (this.disposed) throw new Error(`${this.options.command}: the client was disposed.`)
		if (this.running && !this.running.exited) return this.running
		if (!this.starting) {
			this.starting = this.startProcess().finally(() => {
				this.starting = undefined
			})
		}
		return this.starting
	}

	private async startProcess(): Promise<Running> {
		const { command, args, env, cwd } = this.options
		let child: ChildProcessWithoutNullStreams
		try {
			child = this.options.spawnProcess
				? this.options.spawnProcess(command, args, { env, cwd })
				: spawn(command, args as string[], {
						env,
						cwd,
						stdio: ['pipe', 'pipe', 'pipe'],
						windowsHide: true,
					})
		} catch (error) {
			throw new Error(
				`Could not start ${command}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		const startOrdinal = ++this.startCount
		let markClosed: () => void = () => undefined
		const running: Running = {
			child,
			startOrdinal,
			pending: new Map(),
			stderr: [],
			exited: false,
			closed: new Promise<void>((resolve) => {
				markClosed = resolve
			}),
		}
		let spawnError: Error | undefined
		child.stdin.on('error', () => undefined)
		child.stderr.setEncoding('utf8')
		child.stderr.on('data', (text: string) => {
			running.stderr.push(text)
			let total = running.stderr.reduce((sum, part) => sum + part.length, 0)
			while (total > STDERR_TAIL_BYTES && running.stderr.length > 1) {
				total -= running.stderr.shift()?.length ?? 0
			}
		})
		const splitter = new LineSplitter((line) => this.onLine(running, line))
		child.stdout.on('data', (chunk: Buffer) => splitter.push(chunk))
		const onGone = (exitCode: number | null, signal: NodeJS.Signals | null) => {
			if (running.exited) return
			running.exited = true
			if (this.running === running) this.running = undefined
			const timedOut = running.killedFor === 'timeout'
			for (const [id, pending] of running.pending) {
				clearTimeout(pending.timer)
				running.pending.delete(id)
				pending.reject(
					this.lostRequest(running, pending.method, exitCode, signal, timedOut, spawnError),
				)
			}
			markClosed()
		}
		child.once('error', (error) => {
			spawnError = error
			onGone(null, null)
		})
		child.once('close', (code, signal) => onGone(code, signal))

		try {
			await this.request(
				running,
				'initialize',
				{
					protocolVersion: this.options.protocolVersion ?? '2025-06-18',
					capabilities: {},
					clientInfo: {
						name: this.options.clientName ?? 'namzu-computer-use',
						version: this.options.clientVersion ?? '0',
					},
				},
				this.options.startTimeoutMs ?? 20_000,
			)
			this.notify(running, 'notifications/initialized')
			if (this.options.afterStart) {
				await this.options.afterStart((name, toolArgs, timeoutMs) =>
					this.callOn(running, name, toolArgs ?? {}, timeoutMs),
				)
			}
		} catch (error) {
			if (!running.exited) {
				running.child.kill('SIGKILL')
				await running.closed
			}
			const reason = error instanceof Error ? error.message : String(error)
			throw new Error(`${command} did not start: ${reason}${tail(running.stderr)}`)
		}
		if (this.disposed) {
			running.child.kill('SIGKILL')
			throw new Error(`${command}: the client was disposed.`)
		}
		this.running = running
		return running
	}

	private async callOn(
		running: Running,
		name: string,
		args: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<McpToolResult> {
		const raw = (await this.request(
			running,
			'tools/call',
			{ name, arguments: args },
			timeoutMs ?? this.options.requestTimeoutMs ?? 15_000,
		)) as {
			content?: unknown
			structuredContent?: unknown
			isError?: unknown
		} | null
		const content = Array.isArray(raw?.content) ? (raw.content as McpContent[]) : []
		const structuredContent =
			raw?.structuredContent && typeof raw.structuredContent === 'object'
				? (raw.structuredContent as Record<string, unknown>)
				: undefined
		if (raw?.isError === true) {
			const text = content
				.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
				.map((part) => part.text)
				.join('\n')
				.trim()
			throw new McpToolError(name, text || `${name} failed without saying why.`, structuredContent)
		}
		return structuredContent === undefined ? { content } : { content, structuredContent }
	}

	private request(
		running: Running,
		method: string,
		params: unknown,
		timeoutMs: number,
	): Promise<unknown> {
		if (running.exited) {
			return Promise.reject(new Error(`${this.options.command} is not running.`))
		}
		if (this.disposed && running.killedFor === 'dispose') {
			return Promise.reject(new Error(`${this.options.command}: the client was disposed.`))
		}
		const id = this.nextId++
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!running.pending.has(id)) return
				// Unresponsive: kill it. The close handler rejects this request
				// (and any other in flight) as timed out; the next call restarts.
				running.killedFor = 'timeout'
				running.child.kill('SIGKILL')
			}, timeoutMs)
			running.pending.set(id, { method, resolve, reject, timer })
			running.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
		})
	}

	private notify(running: Running, method: string, params?: unknown): void {
		if (running.exited) return
		const message =
			params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
		running.child.stdin.write(`${JSON.stringify(message)}\n`)
	}

	private onLine(running: Running, line: Buffer): void {
		if (line.length === 0) return
		let message: {
			id?: unknown
			method?: unknown
			result?: unknown
			error?: { code?: unknown; message?: unknown }
		}
		try {
			message = JSON.parse(line.toString('utf8'))
		} catch {
			return // Not protocol: a stray line a server printed to stdout.
		}
		if (typeof message !== 'object' || message === null) return
		if (typeof message.method === 'string') {
			// A request from the server (it has an id) gets an answer so it does
			// not wait; nothing this client offers is ever asked for, except ping.
			if (message.id !== undefined && message.id !== null && !running.exited) {
				const reply =
					message.method === 'ping'
						? { jsonrpc: '2.0', id: message.id, result: {} }
						: {
								jsonrpc: '2.0',
								id: message.id,
								error: {
									code: -32601,
									message: `Method not found: ${message.method}`,
								},
							}
				running.child.stdin.write(`${JSON.stringify(reply)}\n`)
			}
			return
		}
		if (typeof message.id !== 'number') return
		const pending = running.pending.get(message.id)
		if (!pending) return
		running.pending.delete(message.id)
		clearTimeout(pending.timer)
		if (message.error) {
			pending.reject(
				new McpProtocolError(
					pending.method,
					typeof message.error.code === 'number' ? message.error.code : -32603,
					typeof message.error.message === 'string' ? message.error.message : 'unknown error',
				),
			)
			return
		}
		pending.resolve(message.result)
	}

	private lostRequest(
		running: Running,
		method: string,
		exitCode: number | null,
		signal: NodeJS.Signals | null,
		timedOut: boolean,
		spawnError: Error | undefined,
	): Error {
		const { command, args } = this.options
		const stderr = running.stderr.join('')
		if (spawnError) return new Error(`Could not start ${command}: ${spawnError.message}`)
		const message = timedOut
			? `${command} did not answer ${method} in time and was stopped.${tail(running.stderr)}`
			: running.killedFor === 'dispose'
				? `${command} was stopped before it answered ${method}.`
				: `${command} exited (code ${exitCode ?? 'none'}${signal ? `, ${signal}` : ''}) before it answered ${method}.${tail(running.stderr)}`
		return new SpawnError(
			message,
			{
				exitCode: exitCode ?? -1,
				stdout: Buffer.alloc(0),
				stderr,
				timedOut,
				signal,
			},
			command,
			args,
		)
	}
}

function tail(parts: readonly string[]): string {
	const text = parts.join('').trim()
	if (text.length === 0) return ''
	return ` It said: ${text.length > 600 ? `…${text.slice(-600)}` : text}`
}

const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d

/**
 * Cuts a byte stream into lines at `\n` (a trailing `\r` is dropped). Chunks
 * are kept as they arrive and joined once per line, so a screenshot's
 * multi-megabyte line costs one copy.
 */
export class LineSplitter {
	private pending: Buffer[] = []
	private pendingBytes = 0

	constructor(private readonly onLine: (line: Buffer) => void) {}

	push(chunk: Buffer): void {
		let start = 0
		for (;;) {
			const at = chunk.indexOf(NEWLINE, start)
			if (at === -1) break
			let line: Buffer
			const part = chunk.subarray(start, at)
			if (this.pendingBytes > 0) {
				this.pending.push(part)
				line = Buffer.concat(this.pending, this.pendingBytes + part.length)
				this.pending = []
				this.pendingBytes = 0
			} else {
				line = part
			}
			if (line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN) {
				line = line.subarray(0, line.length - 1)
			}
			this.onLine(line)
			start = at + 1
		}
		if (start < chunk.length) {
			const rest = chunk.subarray(start)
			this.pending.push(rest)
			this.pendingBytes += rest.length
		}
	}
}
