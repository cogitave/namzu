import { randomBytes, randomUUID } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws'
import type { PalComputerStreamView } from '../shared/protocol.js'

export interface PalStreamDescriptor {
	protocol: 'rfb'
	url: string
	authorization: string
	width: number
	height: number
	generation: string
}
interface Viewer {
	view: PalComputerStreamView
	descriptor: PalStreamDescriptor
	ticket: string
	closed: boolean
	connected: boolean
	sockets: WebSocket[]
	streams: Duplex[]
}

/** The renderer receives an ephemeral observation ticket, never the allocation bearer. */
export class PalStreamProxy {
	private readonly server: Server
	private readonly upgrades = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
	private readonly viewers = new Map<string, Viewer>()
	private readonly closeListeners = new Set<(id: string) => void>()
	private origin = 'null'
	private port = 0
	private closed = false
	constructor(private readonly onFailure: () => void = () => {}) {
		this.server = createServer((_request, response) => {
			response.writeHead(404)
			response.end()
		})
		this.server.on('upgrade', (request, socket, head) => {
			const viewer = [...this.viewers.values()].find(
				(value) => request.url === `/stream/${value.ticket}`,
			)
			if (
				this.closed ||
				!viewer ||
				viewer.closed ||
				viewer.connected ||
				request.headers.origin !== this.origin ||
				request.headers.host !== `127.0.0.1:${this.port}`
			) {
				socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
				return
			}
			viewer.connected = true
			this.upgrades.handleUpgrade(request, socket, head, (downstream) => {
				const upstream = new WebSocket(viewer.descriptor.url, {
					headers: { Authorization: viewer.descriptor.authorization },
					followRedirects: false,
					perMessageDeflate: false,
					maxPayload: 16 * 1024 * 1024,
					handshakeTimeout: 10_000,
				})
				viewer.sockets.push(downstream, upstream)
				const fail = () => {
					if (viewer.closed) return
					this.onFailure()
					this.close(viewer.view.id)
				}
				// Validate before the duplex listeners can forward a text payload.
				for (const channel of viewer.sockets)
					channel.on('message', (_bytes, binary) => {
						if (!binary) fail()
					})
				// RFB is a byte stream. Duplex piping propagates backpressure without
				// dropping rectangles or collecting per-frame IPC/React messages.
				const incoming = createWebSocketStream(downstream, { highWaterMark: 64 * 1024 })
				const outgoing = createWebSocketStream(upstream, { highWaterMark: 64 * 1024 })
				viewer.streams.push(incoming, outgoing)
				incoming.on('error', fail)
				outgoing.on('error', fail)
				for (const channel of viewer.sockets) {
					channel.on('error', fail)
					channel.on('close', () => this.close(viewer.view.id))
				}
				incoming.pipe(outgoing).pipe(incoming)
			})
		})
	}
	async start(): Promise<number> {
		if (this.closed) throw new Error('The computer viewer is closed.')
		if (this.port) return this.port
		await new Promise<void>((resolve, reject) => {
			this.server.once('error', reject)
			this.server.listen(0, '127.0.0.1', () => {
				this.server.off('error', reject)
				resolve()
			})
		})
		const address = this.server.address()
		if (!address || typeof address === 'string') throw new Error('No computer viewer address.')
		this.port = address.port
		return this.port
	}
	allowRenderer(page: string): void {
		const url = new URL(page)
		// Chromium serializes its file origin as file://; Node's URL uses null.
		this.origin = url.protocol === 'file:' ? 'file://' : url.origin
	}
	onClosed(listener: (id: string) => void): () => void {
		this.closeListeners.add(listener)
		return () => {
			this.closeListeners.delete(listener)
		}
	}
	open(raw: unknown, generation: string): PalComputerStreamView {
		if (this.closed || !this.port) throw new Error('The computer viewer is unavailable.')
		if (this.viewers.size >= 8) throw new Error('Close another computer view first.')
		if (!raw || typeof raw !== 'object') throw new Error('Invalid computer stream.')
		const descriptor = raw as PalStreamDescriptor
		if (typeof descriptor.url !== 'string') throw new Error('Invalid computer stream.')
		let url: URL
		try {
			url = new URL(descriptor.url)
		} catch {
			throw new Error('Invalid computer stream.')
		}
		if (
			descriptor.protocol !== 'rfb' ||
			descriptor.generation !== generation ||
			!Number.isSafeInteger(Number(generation)) ||
			!/^[1-9][0-9]{0,15}$/.test(generation) ||
			url.protocol !== 'ws:' ||
			url.hostname !== '127.0.0.1' ||
			!url.port ||
			Number(url.port) < 1 ||
			url.pathname !== '/stream' ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			typeof descriptor.authorization !== 'string' ||
			!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(descriptor.authorization) ||
			!Number.isSafeInteger(descriptor.width) ||
			!Number.isSafeInteger(descriptor.height) ||
			descriptor.width < 1 ||
			descriptor.width > 4096 ||
			descriptor.height < 1 ||
			descriptor.height > 3072
		)
			throw new Error('Invalid computer stream.')
		const id = randomUUID()
		const ticket = randomBytes(32).toString('hex')
		const view = {
			id,
			url: `ws://127.0.0.1:${this.port}/stream/${ticket}`,
			width: descriptor.width,
			height: descriptor.height,
			generation,
		}
		this.viewers.set(id, {
			view,
			descriptor: { ...descriptor },
			ticket,
			closed: false,
			connected: false,
			sockets: [],
			streams: [],
		})
		return { ...view }
	}
	close(id: string): void {
		const viewer = this.viewers.get(id)
		if (!viewer) return
		viewer.closed = true
		this.viewers.delete(id)
		for (const listener of this.closeListeners) listener(id)
		for (const channel of viewer.sockets) channel.terminate()
		for (const stream of viewer.streams) stream.destroy()
	}
	async shutdown(): Promise<void> {
		if (this.closed) return
		this.closed = true
		for (const id of this.viewers.keys()) this.close(id)
		this.upgrades.close()
		this.server.closeAllConnections()
		if (this.server.listening)
			await new Promise<void>((resolve) => this.server.close(() => resolve()))
	}
}
