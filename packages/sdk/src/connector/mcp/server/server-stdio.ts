import type { Readable, Writable } from 'node:stream'
import { SCOPE_ATTRIBUTE } from '../../../utils/log/types.js'

import type { MCPJsonRpcMessage, MCPTransport } from '../../../types/connector/mcp.js'
import { type Logger, resolveLogger } from '../../../utils/logger.js'

/**
 * The server half of stdio, so `MCPServer` has something to run on.
 *
 * `MCPServer` is a complete implementation — `initialize`, `tools/list`,
 * `tools/call`, resource and prompt providers — and nothing anywhere
 * constructed one, because every transport in this directory is the
 * CLIENT side. `StdioTransport` spawns a child and talks to its streams;
 * this reads the streams THIS process was given. Same interface, opposite
 * end of the pipe.
 *
 * Stdio is the first transport rather than an afterthought: a client
 * spawns the server as a child process, so there is no port, no bind
 * address and no inbound authentication question to get wrong. The
 * boundary is the process, and the process was started by the client.
 *
 * **stdout belongs to the protocol.** A single stray `console.log`
 * anywhere in the process corrupts the message stream, and the symptom is
 * a client that reports malformed JSON rather than anything naming the
 * culprit. This repository's logger already writes to stderr, which is
 * what makes this transport safe to add; keep it that way.
 */
export class ServerStdioTransport implements MCPTransport {
	private readonly input: Readable
	private readonly output: Writable
	private buffer = ''
	private connected = false
	private readonly log: Logger

	private messageHandler?: (message: MCPJsonRpcMessage) => void
	private closeHandler?: () => void
	private errorHandler?: (error: Error) => void

	private readonly onData = (chunk: Buffer | string): void => this.consume(chunk)
	private readonly onEnd = (): void => {
		this.connected = false
		this.closeHandler?.()
	}
	private readonly onStreamError = (err: Error): void => this.errorHandler?.(err)

	/**
	 * Streams are injected rather than read from `process` directly so a
	 * test can drive this without owning the process's own stdio — a test
	 * that replaced `process.stdin` would break every other test sharing
	 * the runner.
	 */
	constructor(streams?: { input?: Readable; output?: Writable }, log?: Logger) {
		this.input = streams?.input ?? process.stdin
		this.output = streams?.output ?? process.stdout
		this.log = resolveLogger(log).child({ [SCOPE_ATTRIBUTE]: 'connector/mcp/server/stdio' })
	}

	async connect(): Promise<void> {
		if (this.connected) return
		this.input.setEncoding?.('utf8')
		this.input.on('data', this.onData)
		this.input.on('end', this.onEnd)
		this.input.on('error', this.onStreamError)
		this.connected = true
		this.log.info('MCP stdio server listening on this process')
	}

	async close(): Promise<void> {
		if (!this.connected) return
		this.input.off('data', this.onData)
		this.input.off('end', this.onEnd)
		this.input.off('error', this.onStreamError)
		this.connected = false
		this.closeHandler?.()
	}

	async send(message: MCPJsonRpcMessage): Promise<void> {
		// Newline-delimited JSON, one message per line. A message carrying a
		// literal newline would split into two unparseable halves, so it is
		// stripped by `JSON.stringify` escaping rather than by trusting the
		// payload.
		this.output.write(`${JSON.stringify(message)}\n`)
	}

	onMessage(handler: (message: MCPJsonRpcMessage) => void): void {
		this.messageHandler = handler
	}

	onClose(handler: () => void): void {
		this.closeHandler = handler
	}

	onError(handler: (error: Error) => void): void {
		this.errorHandler = handler
	}

	isConnected(): boolean {
		return this.connected
	}

	/**
	 * A chunk is not a message. Reads arrive at whatever size the pipe
	 * hands over, so one read can carry half a message, several messages,
	 * or the tail of one and the head of the next. Buffering until a
	 * newline is the whole protocol framing.
	 */
	private consume(chunk: Buffer | string): void {
		this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')

		let newline = this.buffer.indexOf('\n')
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim()
			this.buffer = this.buffer.slice(newline + 1)
			if (line) this.deliver(line)
			newline = this.buffer.indexOf('\n')
		}
	}

	private deliver(line: string): void {
		let message: MCPJsonRpcMessage
		try {
			message = JSON.parse(line) as MCPJsonRpcMessage
		} catch (err) {
			// Reported, not thrown, and not fatal. A client that sends one bad
			// line has not ended the session, and killing the transport over it
			// would take down every other conversation on this pipe. The
			// alternative — silence — is worse: a request that vanishes looks
			// to the client exactly like a server that hung.
			this.errorHandler?.(
				new Error(
					`MCP stdio server could not parse a message: ${err instanceof Error ? err.message : String(err)}`,
				),
			)
			return
		}
		this.messageHandler?.(message)
	}
}
