import { type EventEmitter, once } from 'node:events'
import { readFileSync } from 'node:fs'
import type { Server as HttpServer, IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { type Server, type Socket, createConnection, createServer } from 'node:net'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
interface Viewer extends EventEmitter {
	send(data: string | Buffer): void
	terminate(): void
}
const { WebSocket } = require('ws') as {
	WebSocket: new (url: string, options?: { headers?: Record<string, string> }) => Viewer
}
const { createDesktopServer } = require('../../../local-computer/desktop-worker.cjs') as {
	createDesktopServer(options: {
		token: string
		stream?: boolean
		connectVnc?: () => Socket
		run: (binary: string, args: string[]) => Promise<Buffer>
		fetchBrowser: () => Promise<boolean>
	}): HttpServer
}
const TOKEN = 'private-owned-test-allocation-token'
const servers: Array<Server | HttpServer> = []
const sockets = new Set<Socket>()
const viewers: Viewer[] = []
const png = Buffer.alloc(24)
png.write('89504e470d0a1a0a', 0, 'hex')
png.writeUInt32BE(1280, 16)
png.writeUInt32BE(800, 20)

function ownedSocket(socket: Socket): Socket {
	sockets.add(socket)
	socket.on('error', () => {})
	socket.on('close', () => sockets.delete(socket))
	return socket
}
async function listen(server: Server | HttpServer): Promise<number> {
	servers.push(server)
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Test listener did not bind')
	return address.port
}
async function guest(accept: (socket: Socket) => void) {
	const port = await listen(createServer((socket) => accept(ownedSocket(socket))))
	return vi.fn(() => ownedSocket(createConnection({ host: '127.0.0.1', port })))
}
async function desktop(connectVnc: () => Socket, stream = true) {
	const server = createDesktopServer({
		token: TOKEN,
		stream,
		connectVnc,
		run: async (binary) => (binary === 'maim' ? png : Buffer.from('1280 800')),
		fetchBrowser: async () => true,
	})
	const port = await listen(server)
	return { server, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/stream` }
}
function viewer(
	url: string,
	headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Viewer {
	const socket = new WebSocket(url, { headers })
	viewers.push(socket)
	socket.on('error', () => {})
	return socket
}
function bytes(value: unknown): Buffer {
	if (!Buffer.isBuffer(value)) throw new Error('Expected binary RFB bytes')
	return value
}
afterEach(async () => {
	for (const viewer of viewers.splice(0)) viewer.terminate()
	for (const socket of sockets) socket.destroy()
	for (const server of servers.splice(0).reverse())
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		)
})

describe('owned guest view-only screen stream', () => {
	it('advertises RFB only after a real, possibly fragmented, guest protocol banner', async () => {
		const connect = await guest((socket) => {
			socket.write('RFB 003.')
			socket.end('008\n')
		})
		const worker = await desktop(connect)
		const response = await fetch(`${worker.http}/readyz`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ stream: { protocol: 'rfb' } })
		expect(connect).toHaveBeenCalledOnce()
	})
	it('does not claim connected stream support for a non-RFB listener or an old image', async () => {
		const connect = await guest((socket) => socket.end('not-RFB-data'))
		const worker = await desktop(connect)
		const headers = { authorization: `Bearer ${TOKEN}` }
		expect((await fetch(`${worker.http}/readyz`, { headers })).status).toBe(503)
		const oldImage = await desktop(connect, false)
		const oldReadiness = await fetch(`${oldImage.http}/readyz`, { headers })
		expect(oldReadiness.status).toBe(200)
		expect(await oldReadiness.json()).not.toHaveProperty('stream')
		expect(connect).toHaveBeenCalledOnce()
	})
	it('authenticates and rejects browser Origin and alternate targets before opening any VNC socket', async () => {
		const connect = await guest((socket) => socket.end())
		const worker = await desktop(connect)
		for (const [url, headers, expected] of [
			[worker.ws, {}, 401],
			[worker.ws, { authorization: `Bearer ${TOKEN}`, origin: 'http://127.0.0.1' }, 401],
			[`${worker.ws}?target=host:5900`, { authorization: `Bearer ${TOKEN}` }, 404],
		] as const) {
			const socket = viewer(url, headers)
			const response = once(socket, 'unexpected-response')
			const [, reply] = await response
			expect((reply as IncomingMessage).statusCode).toBe(expected)
			;(reply as IncomingMessage).resume()
			socket.terminate()
		}
		expect(connect).not.toHaveBeenCalled()
	})
	it('passes binary protocol bytes with no shell/input dispatch and ends the guest socket when the viewer closes', async () => {
		let accepted!: Socket
		const connect = await guest((socket) => {
			accepted = socket
			socket.write('RFB 003.008\n')
		})
		const worker = await desktop(connect)
		const socket = viewer(worker.ws)
		const banner = once(socket, 'message')
		expect(bytes((await banner)[0]).toString('ascii')).toBe('RFB 003.008\n')
		const handshake = once(accepted, 'data')
		socket.send(Buffer.from('RFB 003.008\n'))
		expect(bytes((await handshake)[0]).toString('ascii')).toBe('RFB 003.008\n')
		const frame = once(socket, 'message')
		accepted.write(Buffer.from([0, 0, 0, 1, 0, 7]))
		expect(bytes((await frame)[0])).toEqual(Buffer.from([0, 0, 0, 1, 0, 7]))
		const closed = once(accepted, 'close')
		socket.terminate()
		await closed
	})
	it.each(['text', 'oversized'] as const)(
		'refuses %s frames and retires both directions',
		async (kind) => {
			let accepted!: Socket
			const received: Buffer[] = []
			const connect = await guest((socket) => {
				accepted = socket
				socket.on('data', (data) => received.push(data))
				socket.write('RFB 003.008\n')
			})
			const worker = await desktop(connect)
			const socket = viewer(worker.ws)
			await once(socket, 'message')
			const closed = once(accepted, 'close')
			socket.send(kind === 'text' ? 'raw text is not RFB' : Buffer.alloc(65 * 1024))
			await closed
			expect(received).toEqual([])
		},
	)
	it('bounds viewer count and closes the view when the guest exits', async () => {
		const accepted: Socket[] = []
		const connect = await guest((socket) => {
			accepted.push(socket)
			socket.write('RFB 003.008\n')
		})
		const worker = await desktop(connect)
		for (let index = 0; index < 4; index += 1) {
			const socket = viewer(worker.ws)
			await once(socket, 'message')
		}
		const rejected = viewer(worker.ws)
		const [, response] = await once(rejected, 'unexpected-response')
		expect((response as IncomingMessage).statusCode).toBe(503)
		;(response as IncomingMessage).resume()
		rejected.terminate()
		expect(connect).toHaveBeenCalledTimes(4)
		const closed = once(viewers[0]!, 'close')
		accepted[0]!.destroy()
		await closed
	})
	it('propagates outbound backpressure to the guest source without retaining whole frames', async () => {
		let finish!: (paused: boolean) => void
		const paused = new Promise<boolean>((resolve) => {
			finish = resolve
		})
		let source!: Duplex
		const worker = await desktop(() => {
			let sent = false
			source = new Duplex({
				readableHighWaterMark: 64 * 1024,
				writableHighWaterMark: 64 * 1024,
				read() {
					if (sent) return
					sent = true
					this.push(Buffer.alloc(64 * 1024))
				},
				write(_chunk, _encoding, callback) {
					callback()
				},
			})
			source.once('pause', () => finish(source.isPaused()))
			// One exact high-water-mark chunk determines the result; no
			// wall-clock deadline or network-speed race decides this test.
			Object.assign(source, { setTimeout: () => source })
			return source as Socket
		})
		const socket = viewer(worker.ws)
		await expect(paused).resolves.toBe(true)
		const closed = once(source, 'close')
		socket.terminate()
		await closed
	})
	it('retires upgraded viewers and guest sockets when the owned worker listener closes', async () => {
		let accepted!: Socket
		const connect = await guest((socket) => {
			accepted = socket
			socket.write('RFB 003.008\n')
		})
		const worker = await desktop(connect)
		const socket = viewer(worker.ws)
		await once(socket, 'message')
		const viewerClosed = once(socket, 'close')
		const guestClosed = once(accepted, 'close')
		await new Promise<void>((resolve, reject) =>
			worker.server.close((error) => (error ? reject(error) : resolve())),
		)
		servers.splice(servers.indexOf(worker.server), 1)
		await Promise.all([viewerClosed, guestClosed])
	})
	it('keeps the shipped VNC source guest-local and disables input, clipboard and remote reconfiguration', () => {
		const entrypoint = readFileSync(
			new URL('../../../local-computer/entrypoint.sh', import.meta.url),
			'utf8',
		)
		for (const flag of [
			'-listen 127.0.0.1',
			'-viewonly',
			'-noclipboard',
			'-noprimary',
			'-nosetclipboard',
			'-nosetprimary',
			'-norc',
			'-noremote',
		])
			expect(entrypoint).toContain(flag)
		const dockerfile = readFileSync(
			new URL('../../../local-computer/Dockerfile', import.meta.url),
			'utf8',
		)
		expect(dockerfile).toContain('ws@8.21.3')
		expect(dockerfile).toContain('EXPOSE 2024 2025')
		expect(dockerfile).not.toContain('EXPOSE 5900')
	})
})
