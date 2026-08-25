import { type ChildProcess, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import type {
	CodeNavigationProvider,
	CodeNavigationResult,
	HoverResult,
	SourceLocation,
	SymbolLocation,
	SymbolSearchResult,
} from './types.js'

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
	/**
	 * What the server said it can do, read from the initialize RESULT.
	 *
	 * Read rather than probed. Sending `workspace/symbol` to a server that
	 * does not implement it and swallowing the error works until a server
	 * answers a different error for a different reason — a transient one, a
	 * malformed query — and the fallback then fires for a capability the
	 * server has. The handshake already carries the answer.
	 */
	private capabilities: Record<string, unknown> = {}
	/**
	 * The first terminal failure, shared by startup and the live transport.
	 *
	 * A process may stay alive after closing one of its protocol streams. The
	 * process handle therefore remains owned until `dispose`; this latch only
	 * prevents more protocol work and gives every waiter the same explanation.
	 */
	private terminalError: string | undefined
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

	async hover(file: string, line: number, character: number): Promise<HoverResult> {
		try {
			await this.start()
		} catch (err) {
			return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
		}
		if (this.capabilities.hoverProvider === false) {
			return { kind: 'unsupported', reason: `${this.options.command} declares no hoverProvider.` }
		}
		try {
			const result = await this.request('textDocument/hover', {
				textDocument: { uri: pathToFileURL(file).href },
				position: { line, character },
			})
			// EMPTY, not failed. Hovering over whitespace or a comment resolves
			// to nothing, and a caller has to be able to tell that from a server
			// that broke — the same distinction `locations: []` carries.
			return { kind: 'hover', contents: hoverText(result) }
		} catch (err) {
			return toFailure(err, `${this.options.command}`, 'textDocument/hover')
		}
	}

	async symbols(query: string, _scope?: string): Promise<SymbolSearchResult> {
		try {
			await this.start()
		} catch (err) {
			return { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
		}

		// The DECLARED capability decides which request goes out. A server
		// with a workspace index answers the whole repository; one with only
		// document symbols answers the file it is given; one with neither is
		// told so rather than asked and silently mishandled.
		if (this.capabilities.workspaceSymbolProvider) {
			try {
				const result = await this.request('workspace/symbol', { query })
				return { kind: 'symbols', symbols: toSymbols(result) }
			} catch (err) {
				return toFailure(err, this.options.command, 'workspace/symbol')
			}
		}
		if (this.capabilities.documentSymbolProvider) {
			if (!_scope) {
				return {
					kind: 'unsupported',
					reason: `${this.options.command} has no workspace symbol index, so a symbol search needs a file to look in. Pass a scope.`,
				}
			}
			try {
				const result = await this.request('textDocument/documentSymbol', {
					textDocument: { uri: pathToFileURL(_scope).href },
				})
				return {
					kind: 'symbols',
					symbols: toSymbols(result, _scope).filter((s) => s.name.includes(query)),
				}
			} catch (err) {
				return toFailure(err, this.options.command, 'textDocument/documentSymbol')
			}
		}
		return {
			kind: 'unsupported',
			reason: `${this.options.command} declares neither workspaceSymbolProvider nor documentSymbolProvider, so it cannot find a symbol by name.`,
		}
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
		if (this.terminalError) return Promise.reject(new Error(this.terminalError))
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

			this.observeTransport(child)

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

			const initialized = await Promise.race([
				this.request('initialize', {
					processId: process.pid,
					rootUri: pathToFileURL(this.options.rootDir).href,
					workspaceFolders: [{ uri: pathToFileURL(this.options.rootDir).href, name: 'workspace' }],
					capabilities: {},
				}),
				timeout,
			])
			if (this.terminalError) throw new Error(this.terminalError)
			// Stored from the initialize RESULT, which is the only place a
			// server states what it can do. Everything downstream reads this
			// instead of sending a request and interpreting the error.
			this.capabilities =
				(initialized as { capabilities?: Record<string, unknown> } | undefined)?.capabilities ?? {}
			this.notify('initialized', {})
		})().catch((err: unknown) => {
			// Remembered, so a run that asks twenty times does not spawn twenty
			// servers against a binary that is not there.
			this.retireTransport(toError(err))
			throw err
		})

		return this.starting
	}

	private request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (this.disposed)
			return Promise.reject(new Error('This code navigation provider is disposed.'))
		if (this.terminalError) return Promise.reject(new Error(this.terminalError))
		if (!this.child) {
			return Promise.reject(
				new Error(`The language server "${this.options.command}" is not running.`),
			)
		}
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
			try {
				this.write({ jsonrpc: '2.0', id, method, params })
			} catch (err) {
				this.retireTransport(toError(err))
			}
		})
	}

	private notify(method: string, params: Record<string, unknown>): void {
		this.write({ jsonrpc: '2.0', method, params })
	}

	private write(message: Record<string, unknown>): void {
		if (this.disposed) throw new Error('This code navigation provider is disposed.')
		if (this.terminalError) throw new Error(this.terminalError)
		const child = this.child
		if (!child) throw new Error(`The language server "${this.options.command}" is not running.`)
		this.writeTo(child, message)
	}

	private writeTo(child: ChildProcess, message: Record<string, unknown>): void {
		const stdin = child.stdin
		if (!stdin || stdin.destroyed || !stdin.writable) {
			throw new Error(`The language server "${this.options.command}" request stream is closed.`)
		}
		const body = Buffer.from(JSON.stringify(message), 'utf-8')
		// One write keeps concurrent requests from interleaving a header from
		// one frame with the body of another.
		stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
	}

	private observeTransport(child: ChildProcess): void {
		child.on('error', (err) => {
			this.retireTransport(
				new Error(`Could not run the language server "${this.options.command}": ${err.message}`),
			)
		})
		child.on('exit', (code, signal) => {
			const outcome = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
			this.retireTransport(
				new Error(`The language server "${this.options.command}" exited with ${outcome}.`),
			)
		})

		child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk))
		child.stdout?.on('end', () => {
			this.retireTransport(
				new Error(
					`The language server "${this.options.command}" response stream closed unexpectedly.`,
				),
			)
		})
		child.stdout?.on('close', () => {
			this.retireTransport(
				new Error(
					`The language server "${this.options.command}" response stream closed unexpectedly.`,
				),
			)
		})
		child.stdout?.on('error', (err) => {
			this.retireTransport(
				new Error(
					`The language server "${this.options.command}" response stream failed: ${err.message}`,
				),
			)
		})
		child.stdin?.on('close', () => {
			this.retireTransport(
				new Error(
					`The language server "${this.options.command}" request stream closed unexpectedly.`,
				),
			)
		})
		child.stdin?.on('error', (err) => {
			this.retireTransport(
				new Error(
					`The language server "${this.options.command}" request stream failed: ${err.message}`,
				),
			)
		})
	}

	/** Fail every waiter once, but retain the child handle for bounded teardown. */
	private retireTransport(error: Error): void {
		if (this.disposed) return
		this.terminalError ??= error.message
		for (const waiting of this.pending.values()) {
			clearTimeout(waiting.timer)
			waiting.reject(new Error(this.terminalError))
		}
		this.pending.clear()
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
			if (child.exitCode !== null || child.signalCode !== null) resolve()
			else child.once('exit', () => resolve())
		})
		try {
			this.writeTo(child, {
				jsonrpc: '2.0',
				id: ++this.seq,
				method: 'shutdown',
				params: {},
			})
			this.writeTo(child, { jsonrpc: '2.0', method: 'exit', params: {} })
		} catch {
			// The pipe is already gone. Falling through to the kill is right.
		}
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

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value))
}

function isLocation(value: unknown): value is LspLocation {
	if (typeof value !== 'object' || value === null) return false
	const candidate = value as { uri?: unknown; range?: { start?: unknown } }
	return typeof candidate.uri === 'string' && typeof candidate.range?.start === 'object'
}

/**
 * A thrown error as the right member of a result union.
 *
 * The two `unsupported`/`failed` arms are identical across all three result
 * types, so this returns that shared shape and each caller widens it. A
 * generic that claimed to produce `T` would be asserting into a union it
 * cannot construct.
 */
function toFailure(
	err: unknown,
	command: string,
	method: string,
): { kind: 'unsupported'; reason: string } | { kind: 'failed'; error: string } {
	const message = err instanceof Error ? err.message : String(err)
	// A method the server does not implement is `unsupported`, not `failed`:
	// a caller can fall back and say why the answer is approximate, where a
	// failure means the answer is unknown.
	if (/method not found|-32601/i.test(message)) {
		return { kind: 'unsupported', reason: `${command} does not implement ${method}.` }
	}
	return { kind: 'failed', error: message }
}

/**
 * The wire's several hover shapes, as one string.
 *
 * `contents` has been a string, a `{ language, value }` pair, an array of
 * either, and a `{ kind, value }` markup object across revisions of the
 * protocol, and servers in the field still send all of them. A reader that
 * handled only the newest returns empty for a server that answered — which
 * is indistinguishable, at the call site, from a symbol with no type.
 */
function hoverText(result: unknown): string {
	if (result === null || result === undefined) return ''
	const contents = (result as { contents?: unknown }).contents
	return flattenHover(contents).join('\n').trim()
}

function flattenHover(value: unknown): string[] {
	if (value === null || value === undefined) return []
	if (typeof value === 'string') return [value]
	if (Array.isArray(value)) return value.flatMap(flattenHover)
	if (typeof value === 'object') {
		const record = value as { value?: unknown; language?: unknown }
		if (typeof record.value === 'string') return [record.value]
	}
	return []
}

/** `workspace/symbol` and `textDocument/documentSymbol` answer differently. */
function toSymbols(result: unknown, fallbackPath?: string): SymbolLocation[] {
	if (!Array.isArray(result)) return []
	const out: SymbolLocation[] = []
	for (const entry of result) {
		if (typeof entry !== 'object' || entry === null) continue
		const item = entry as {
			name?: unknown
			kind?: unknown
			containerName?: unknown
			location?: LspLocation
			range?: LspLocation['range']
			selectionRange?: LspLocation['range']
			children?: unknown
		}
		if (typeof item.name !== 'string') continue

		// `workspace/symbol` carries a `location`; `documentSymbol` carries a
		// `range` and leaves the file implied by the request. Both are handled
		// because the fallback path produces the second shape.
		const location = item.location
			? toSourceLocation(item.location)
			: item.selectionRange || item.range
				? toSourceLocation({
						uri: fallbackPath ? pathToFileURL(fallbackPath).href : '',
						range: (item.selectionRange ?? item.range) as LspLocation['range'],
					})
				: undefined
		if (location) {
			out.push({
				...location,
				name: item.name,
				...(typeof item.kind === 'number' ? { symbolKind: item.kind } : {}),
				...(typeof item.containerName === 'string' ? { containerName: item.containerName } : {}),
			})
		}
		// `documentSymbol` is a TREE. A reader that took only the top level
		// would miss every method, which is most of what somebody searching by
		// name is looking for.
		if (Array.isArray(item.children)) out.push(...toSymbols(item.children, fallbackPath))
	}
	return out
}
