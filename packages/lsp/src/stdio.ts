import { type ChildProcess, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import type { CodeNavigationProvider, CodeNavigationResult, SourceLocation } from './types.js'

/**
 * One language server, over its stdin and stdout.
 *
 * Stdio rather than a socket for the reason every stdio transport in this
 * repository gives: the client spawns the server, so there is no port, no
 * bind address, and no inbound authentication question to get wrong. The
 * boundary is the process.
 *
 * **The framing is not JSON lines.** This wire prefixes each message with a
 * `Content-Length` header and a blank line, so a reader that split on `\n`
 * would tear a message whose body contains one — which every response
 * carrying source text does.
 *
 * **A server that never initializes is a FAILURE, not an empty answer.**
 * The bounded startup timeout exists so a missing binary, a server that
 * crashes on a malformed workspace, or one waiting on a prompt nobody will
 * answer produces `{ kind: 'failed' }` naming the binary. Returning
 * `{ kind: 'locations', locations: [] }` there tells an agent the symbol has
 * no callers, and the agent then deletes it.
 */

export interface StdioCodeNavigationOptions {
	/** The server binary. */
	readonly command: string
	readonly args?: readonly string[]
	/** Workspace root the server indexes. */
	readonly rootDir: string
	/** How long `initialize` may take. */
	readonly startupTimeoutMs?: number
	/** How long any one request may take. */
	readonly requestTimeoutMs?: number
	readonly env?: Readonly<Record<string, string>>
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

interface Pending {
	resolve: (value: unknown) => void
	reject: (error: Error) => void
	timer: NodeJS.Timeout
}

/** LSP's own position shape, before it becomes a {@link SourceLocation}. */
interface LspLocation {
	uri: string
	range: {
		start: { line: number; character: number }
		end?: { line: number; character: number }
	}
}

function toSourceLocation(location: LspLocation): SourceLocation {
	// `file://` off, so a caller gets a path it can hand to `readFile`. The
	// wire speaks URIs because a server may serve untitled buffers; every
	// path this provider is asked about is a real file.
	const path = location.uri.startsWith('file://')
		? decodeURIComponent(new URL(location.uri).pathname)
		: location.uri
	const end = location.range.end
	return {
		path,
		line: location.range.start.line,
		character: location.range.start.character,
		...(end ? { endLine: end.line, endCharacter: end.character } : {}),
	}
}

export class StdioCodeNavigationProvider implements CodeNavigationProvider {
	private child: ChildProcess | undefined
	private buffer = Buffer.alloc(0)
	private seq = 0
	private readonly pending = new Map<number, Pending>()
	private starting: Promise<void> | undefined
	private startupError: string | undefined
	private disposed = false

	constructor(private readonly options: StdioCodeNavigationOptions) {}

	async definition(file: string, line: number, character: number): Promise<CodeNavigationResult> {
		return await this.navigate('textDocument/definition', file, line, character, {})
	}

	async references(file: string, line: number, character: number): Promise<CodeNavigationResult> {
		return await this.navigate('textDocument/references', file, line, character, {
			// The declaration itself is not a "use". An agent asking who calls
			// this wants the call sites; including the declaration inflates the
			// count by one and reads as a caller that does not exist.
			context: { includeDeclaration: false },
		})
	}

	private async navigate(
		method: string,
		file: string,
		line: number,
		character: number,
		extra: Record<string, unknown>,
	): Promise<CodeNavigationResult> {
		try {
			await this.start()
		} catch (err) {
			return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
		}

		try {
			const result = await this.request(method, {
				textDocument: { uri: pathToFileURL(file).href },
				position: { line, character },
				...extra,
			})
			if (result === null || result === undefined) {
				// A server that answered `null` looked and found nothing. That is
				// an empty location list, not a failure — and saying so is what
				// lets a caller tell it apart from a server that never started.
				return { kind: 'locations', locations: [] }
			}
			const raw = Array.isArray(result) ? result : [result]
			return {
				kind: 'locations',
				locations: raw
					.filter((entry): entry is LspLocation => isLocation(entry))
					.map(toSourceLocation),
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			// A method the server does not implement is `unsupported`, not
			// `failed`: a caller can fall back to grep and say why, where a
			// failure means the answer is unknown.
			if (/method not found|-32601/i.test(message)) {
				return {
					kind: 'unsupported',
					reason: `${this.options.command} does not implement ${method}.`,
				}
			}
			return { kind: 'failed', error: message }
		}
	}

	/** Spawn and handshake, once, and remember a failure so it is not retried per call. */
	private start(): Promise<void> {
		if (this.disposed)
			return Promise.reject(new Error('This code navigation provider is disposed.'))
		if (this.startupError) return Promise.reject(new Error(this.startupError))
		if (this.starting) return this.starting

		this.starting = (async () => {
			let child: ChildProcess
			try {
				child = spawn(this.options.command, [...(this.options.args ?? [])], {
					cwd: this.options.rootDir,
					stdio: ['pipe', 'pipe', 'pipe'],
					...(this.options.env ? { env: { ...process.env, ...this.options.env } } : {}),
				})
			} catch (err) {
				throw new Error(
					`Could not start the language server "${this.options.command}": ${err instanceof Error ? err.message : String(err)}`,
				)
			}
			this.child = child

			// A spawn failure arrives asynchronously on some platforms, so the
			// error event has to be able to reject the handshake below rather
			// than surface as an unhandled error on a child nobody is watching.
			const spawnFailure = new Promise<never>((_resolve, reject) => {
				child.once('error', (err) =>
					reject(
						new Error(
							`Could not start the language server "${this.options.command}": ${err.message}`,
						),
					),
				)
				child.once('exit', (code) =>
					reject(
						new Error(
							`The language server "${this.options.command}" exited with code ${code} before it initialized.`,
						),
					),
				)
			})
			// Not unhandled: the race below may settle on the other branch, and
			// an unobserved rejection would take the process down.
			spawnFailure.catch(() => {})

			child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk))

			const startupMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
			const timeout = new Promise<never>((_resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new Error(
								`The language server "${this.options.command}" did not answer initialize within ${startupMs}ms. Refusing rather than answering navigation queries with an empty result.`,
							),
						),
					startupMs,
				)
				timer.unref?.()
			})

			await Promise.race([
				this.request('initialize', {
					processId: process.pid,
					rootUri: pathToFileURL(this.options.rootDir).href,
					workspaceFolders: [{ uri: pathToFileURL(this.options.rootDir).href, name: 'workspace' }],
					capabilities: {},
				}),
				spawnFailure,
				timeout,
			])
			this.notify('initialized', {})
		})().catch((err: unknown) => {
			// Remembered, so a run that asks twenty times does not spawn twenty
			// servers against a binary that is not there.
			this.startupError = err instanceof Error ? err.message : String(err)
			throw err
		})

		return this.starting
	}

	private request(method: string, params: Record<string, unknown>): Promise<unknown> {
		this.seq += 1
		const id = this.seq
		const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`The language server did not answer ${method} within ${timeoutMs}ms.`))
			}, timeoutMs)
			timer.unref?.()
			this.pending.set(id, { resolve, reject, timer })
			this.write({ jsonrpc: '2.0', id, method, params })
		})
	}

	private notify(method: string, params: Record<string, unknown>): void {
		this.write({ jsonrpc: '2.0', method, params })
	}

	private write(message: Record<string, unknown>): void {
		const body = Buffer.from(JSON.stringify(message), 'utf-8')
		this.child?.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`)
		this.child?.stdin?.write(body)
	}

	/**
	 * Read the framed stream.
	 *
	 * Byte lengths, not characters: `Content-Length` counts bytes, and a
	 * response carrying a non-ASCII identifier has more bytes than
	 * characters. Slicing a string by that number cuts the message short and
	 * leaves the parser permanently out of step.
	 */
	private consume(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk])
		for (;;) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n')
			if (headerEnd === -1) return
			const header = this.buffer.subarray(0, headerEnd).toString('utf-8')
			const match = /content-length:\s*(\d+)/i.exec(header)
			if (!match) {
				// A frame with no length is unrecoverable — there is no way to know
				// where it ends. Drop the header and resynchronise rather than
				// spinning on the same bytes forever.
				this.buffer = this.buffer.subarray(headerEnd + 4)
				continue
			}
			const length = Number(match[1])
			const start = headerEnd + 4
			if (this.buffer.length < start + length) return
			const body = this.buffer.subarray(start, start + length).toString('utf-8')
			this.buffer = this.buffer.subarray(start + length)
			this.deliver(body)
		}
	}

	private deliver(body: string): void {
		let message: { id?: number; result?: unknown; error?: { message?: string; code?: number } }
		try {
			message = JSON.parse(body) as typeof message
		} catch {
			// A malformed body is one lost message, not a lost connection: the
			// framing already told us where it ended, so the stream is still in
			// step and the next frame is readable.
			return
		}
		if (message.id === undefined) return
		const waiting = this.pending.get(message.id)
		if (!waiting) return
		this.pending.delete(message.id)
		clearTimeout(waiting.timer)
		if (message.error) {
			waiting.reject(new Error(message.error.message ?? `error ${message.error.code ?? 'unknown'}`))
		} else {
			waiting.resolve(message.result)
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		const child = this.child
		this.child = undefined
		for (const waiting of this.pending.values()) {
			clearTimeout(waiting.timer)
			waiting.reject(new Error('The code navigation provider was disposed.'))
		}
		this.pending.clear()
		if (!child) return

		// The handshake FIRST, so a server with unsaved index state gets to
		// finish. A `kill` alone leaves whatever it was writing half-written,
		// and some servers hold a lock file.
		const exited = new Promise<void>((resolve) => {
			child.once('exit', () => resolve())
		})
		try {
			this.child = child
			this.write({ jsonrpc: '2.0', id: ++this.seq, method: 'shutdown', params: {} })
			this.write({ jsonrpc: '2.0', method: 'exit', params: {} })
		} catch {
			// The pipe is already gone. Falling through to the kill is right.
		}
		this.child = undefined
		child.stdin?.end()

		// Bounded, because a server that ignores `exit` must not keep the run
		// alive. This is the same trade `kill-tree` makes: ask, then insist.
		await Promise.race([
			exited,
			new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					child.kill('SIGKILL')
					resolve()
				}, 2_000)
				timer.unref?.()
			}),
		])
	}
}

function isLocation(value: unknown): value is LspLocation {
	if (typeof value !== 'object' || value === null) return false
	const candidate = value as { uri?: unknown; range?: { start?: unknown } }
	return typeof candidate.uri === 'string' && typeof candidate.range?.start === 'object'
}
