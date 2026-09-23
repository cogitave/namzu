import { randomBytes, timingSafeEqual } from 'node:crypto'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { type WebSocket, WebSocketServer } from 'ws'

/**
 * A WebSocket endpoint on WSL's `127.0.0.1` that Playwright's
 * `connectOverCDP` can use, relaying every message to and from the bridge.
 *
 * The listening port is visible to every process in the distro, so the
 * endpoint lives at a path of 32 random bytes (hex), a request anywhere else
 * is answered 404 before any WebSocket is made, a request carrying an
 * `Origin` header (every browser page's WebSocket does) is refused, and only
 * one client is served at a time.
 */

/** The bridge side of a relay. */
export interface CdpRelayPeer {
	/** Send one CDP message to the browser. */
	send(message: Buffer | string): boolean
	/** Called with every CDP message from the browser. Replaces any earlier listener. */
	onMessage(listener: (message: Buffer) => void): void
}

export interface CdpRelay {
	/** `ws://127.0.0.1:<port>/<token>`. */
	readonly url: string
	/** Stop listening and drop the client. */
	close(): Promise<void>
}

/** Largest message relayed: a full-page screenshot of a very long page, base64. */
const MAX_MESSAGE_BYTES = 512 * 1024 * 1024

function reject(socket: Duplex, status: number, text: string): void {
	socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
	socket.destroy()
}

function samePath(actual: string, expected: string): boolean {
	const a = Buffer.from(actual)
	const b = Buffer.from(expected)
	return a.length === b.length && timingSafeEqual(a, b)
}

export async function startCdpRelay(
	peer: CdpRelayPeer,
	options: { token?: string } = {},
): Promise<CdpRelay> {
	const token = options.token ?? randomBytes(32).toString('hex')
	const path = `/${token}`
	const server: Server = createServer((_request, response) => {
		response.writeHead(404, { Connection: 'close' }).end()
	})
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
	let client: WebSocket | undefined

	peer.onMessage((message) => {
		if (client && client.readyState === client.OPEN) client.send(message, { binary: false })
	})

	server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		if (!samePath(request.url ?? '', path)) return reject(socket, 404, 'Not Found')
		if (request.headers.origin !== undefined) return reject(socket, 403, 'Forbidden')
		if (client) return reject(socket, 409, 'Conflict')
		wss.handleUpgrade(request, socket, head, (ws) => {
			client = ws
			ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
				const buffer = Array.isArray(data)
					? Buffer.concat(data)
					: Buffer.isBuffer(data)
						? data
						: Buffer.from(data)
				peer.send(buffer)
			})
			ws.on('close', () => {
				if (client === ws) client = undefined
			})
			ws.on('error', () => ws.terminate())
		})
	})

	await new Promise<void>((resolve, rejectListen) => {
		server.once('error', rejectListen)
		server.listen(0, '127.0.0.1', () => {
			server.off('error', rejectListen)
			resolve()
		})
	})
	const { port } = server.address() as AddressInfo
	return {
		url: `ws://127.0.0.1:${port}${path}`,
		close: async () => {
			client?.terminate()
			client = undefined
			wss.close()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
}
