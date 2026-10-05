import { StringDecoder } from 'node:string_decoder'
import type { MCPJsonRpcMessage, MCPTransport, MCPTransportSendOptions, Sandbox } from '@namzu/sdk'

type Channel = Awaited<ReturnType<NonNullable<Sandbox['openStdio']>>>
type Operation = Awaited<ReturnType<Channel['beginOperation']>>
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
// The allocation-owned channel admits each stdin write up to 1 MiB. Refuse a
// larger serialized request before reserving an effect barrier or delivering bytes.
const MAX_WRITE_BYTES = 1024 * 1024

/** An idle guest server owns no computer input; each issued RPC owns its effect barrier. */
export class PalGuestMcpTransport implements MCPTransport {
	private channel?: Channel
	private closing?: Promise<void>
	private ended = false
	private messageHandler?: (message: MCPJsonRpcMessage) => void
	private closeHandler?: () => void
	private errorHandler?: (error: Error) => void
	private readonly pending = new Map<
		string | number,
		{ operation: Operation; removeAbort(): void; method: string }
	>()

	constructor(private readonly open: () => Promise<Channel>) {}

	async connect(): Promise<void> {
		if (this.channel || this.ended) throw new Error('This guest MCP transport cannot reconnect.')
		this.channel = await this.open()
		void this.read(this.channel).catch((error: unknown) => {
			this.fail(error instanceof Error ? error : new Error(String(error)))
		})
		// EOF follows buffered stdout. Group exit can be observed before the reader
		// drains its last positive reply, so only a failed close skips that drain.
		void this.channel.closed.catch((error: unknown) =>
			this.fail(error instanceof Error ? error : new Error(String(error))),
		)
	}

	isConnected(): boolean {
		return this.channel !== undefined && !this.ended && !this.closing
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

	async send(message: MCPJsonRpcMessage, options?: MCPTransportSendOptions): Promise<void> {
		options?.signal?.throwIfAborted()
		const channel = this.channel
		if (!channel || !this.isConnected()) throw new Error('This guest MCP channel is closed.')
		const data = `${JSON.stringify(message)}\n`
		if (Buffer.byteLength(data) > MAX_WRITE_BYTES)
			throw new Error('This guest MCP request exceeds the 1 MiB write limit; nothing was sent.')
		const request = message.method !== undefined && message.id !== undefined
		if (!request) {
			await channel.write(data, options?.signal)
			return
		}
		const id = message.id as string | number
		if (this.pending.has(id)) throw new Error('This guest MCP request ID is already active.')
		const operation = await channel.beginOperation(options?.signal)
		// No bytes were handed to the channel on either of these paths.
		if (options?.signal?.aborted || !this.isConnected()) {
			operation.complete()
			options?.signal?.throwIfAborted()
			throw new Error('This guest MCP channel closed before dispatch.')
		}
		const onAbort = () => this.settle(id, false)
		const entry = {
			operation,
			method: message.method as string,
			removeAbort: () => options?.signal?.removeEventListener('abort', onAbort),
		}
		this.pending.set(id, entry)
		options?.signal?.addEventListener('abort', onAbort, { once: true })
		try {
			await channel.write(data, options?.signal)
		} catch (error) {
			// A failed stdin acknowledgement cannot prove the editor did not receive it.
			this.settle(id, false)
			throw error
		}
	}

	private settle(id: string | number, confirmed: boolean): void {
		const entry = this.pending.get(id)
		if (!entry) return
		this.pending.delete(id)
		entry.removeAbort()
		if (confirmed) entry.operation.complete()
		else entry.operation.outcomeUnknown()
	}

	private accept(line: string): void {
		if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES)
			throw new Error('This guest MCP reply exceeds the message limit.')
		const message: unknown = JSON.parse(line)
		if (!message || typeof message !== 'object' || Array.isArray(message))
			throw new Error('This guest MCP server returned an invalid JSON-RPC message.')
		let rpc = message as MCPJsonRpcMessage
		if (rpc.jsonrpc !== '2.0') throw new Error('This guest MCP server returned invalid JSON-RPC.')
		if (rpc.method === undefined && rpc.id !== undefined) {
			if (Object.hasOwn(rpc, 'result') === Object.hasOwn(rpc, 'error'))
				throw new Error('This guest MCP server returned an invalid reply.')
			const entry = this.pending.get(rpc.id)
			const result = rpc.result as Record<string, unknown> | undefined
			const metadata = result?._meta as Record<string, unknown> | undefined
			// An application bridge can lose its editor socket while the editor is still
			// running. A protocol reply is then an honest unknown outcome, not quiescence.
			const outcome = metadata?.['namzu/outcome']
			const unknown =
				outcome === 'unknown' ||
				(entry?.method === 'tools/call' &&
					(rpc.error !== undefined || (outcome !== 'settled' && outcome !== 'not_dispatched')))
			this.settle(rpc.id, !unknown)
			if (unknown && entry?.method === 'tools/call' && !rpc.error) {
				rpc = {
					...rpc,
					result: {
						...result,
						isError: true,
						_meta: { ...metadata, 'namzu/outcome': 'unknown' },
						content: [
							...(Array.isArray(result?.content) ? result.content : []),
							{
								type: 'text',
								text: 'The guest application did not confirm operation completion. Do not repeat the action or take over; stop and restart this computer before further work.',
							},
						],
					},
				}
			}
		}
		this.messageHandler?.(rpc)
	}

	private async read(channel: Channel): Promise<void> {
		const decoder = new StringDecoder('utf8')
		let buffered = ''
		for await (const event of channel.events) {
			if (event.stream !== 'stdout') continue
			buffered += decoder.write(Buffer.from(event.data))
			for (;;) {
				const end = buffered.indexOf('\n')
				if (end < 0) break
				const line = buffered.slice(0, end).replace(/\r$/, '')
				buffered = buffered.slice(end + 1)
				if (line.trim()) this.accept(line)
			}
			if (Buffer.byteLength(buffered) > MAX_MESSAGE_BYTES)
				throw new Error('This guest MCP reply exceeds the message limit.')
		}
		if (!this.closing) {
			if (buffered.length || decoder.end())
				throw new Error('This guest MCP server closed with an incomplete reply.')
			this.end()
		}
	}

	private end(): void {
		if (this.ended) return
		this.ended = true
		for (const id of this.pending.keys()) this.settle(id, false)
		this.closeHandler?.()
	}
	private fail(error: Error): void {
		if (this.ended) return
		this.errorHandler?.(error)
		this.end()
		void this.close().catch(() => undefined)
	}
	close(): Promise<void> {
		if (this.closing) return this.closing
		this.end()
		this.closing = this.channel?.close() ?? Promise.resolve()
		return this.closing
	}
}
