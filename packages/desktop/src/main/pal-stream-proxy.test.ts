import { once } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { type Socket, connect } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { type PalStreamDescriptor, PalStreamProxy } from './pal-stream-proxy.js'

const origin = 'http://127.0.0.1:5173'
const bearer = `Bearer ${'a'.repeat(64)}`
const greeting = Buffer.from('RFB 003.008\n')
const sockets: WebSocket[] = []
const rawSockets: Socket[] = []
const servers: WebSocketServer[] = []
const proxies: PalStreamProxy[] = []

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.terminate()
	for (const socket of rawSockets.splice(0)) socket.destroy()
	for (const proxy of proxies.splice(0)) await proxy.shutdown()
	for (const server of servers.splice(0))
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		)
})

async function upstream() {
	const server = new WebSocketServer({
		host: '127.0.0.1',
		port: 0,
		path: '/stream',
		perMessageDeflate: false,
	})
	servers.push(server)
	const connections: { socket: WebSocket; authorization?: string; bytes: Buffer[] }[] = []
	server.on('connection', (socket, request) => {
		sockets.push(socket)
		socket.on('error', () => {})
		const connection = {
			socket,
			authorization: request.headers.authorization,
			bytes: [] as Buffer[],
		}
		connections.push(connection)
		socket.on('message', (bytes) => connection.bytes.push(Buffer.from(bytes as Buffer)))
		socket.send(greeting, { binary: true })
	})
	await once(server, 'listening')
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('No upstream address')
	const descriptor: PalStreamDescriptor = {
		protocol: 'rfb',
		url: `ws://127.0.0.1:${address.port}/stream`,
		authorization: bearer,
		width: 1280,
		height: 800,
		generation: '7',
	}
	return { connections, descriptor }
}

async function proxy() {
	const failure = vi.fn()
	const instance = new PalStreamProxy(failure)
	proxies.push(instance)
	const port = await instance.start()
	instance.allowRenderer(`${origin}/?private-viewer-port=${port}`)
	return { instance, port, failure }
}

function viewer(url: string, rendererOrigin: string | null = origin, host?: string) {
	const socket = new WebSocket(url, {
		...(rendererOrigin === null ? {} : { origin: rendererOrigin }),
		...(host ? { headers: { Host: host } } : {}),
	})
	sockets.push(socket)
	socket.on('error', () => {})
	return socket
}

async function ready(url: string, rendererOrigin = origin) {
	const socket = viewer(url, rendererOrigin)
	const message = once(socket, 'message')
	await once(socket, 'open')
	const [bytes, binary] = await message
	expect(binary).toBe(true)
	expect(Buffer.from(bytes)).toEqual(greeting)
	return socket
}

async function rejected(socket: WebSocket) {
	const [, response] = await once(socket, 'unexpected-response')
	expect((response as IncomingMessage).statusCode).toBe(403)
	;(response as IncomingMessage).resume()
	socket.terminate()
}

it('relays real local binary bytes in both directions with the allocation bearer kept upstream', async () => {
	const guest = await upstream()
	const host = await proxy()
	const view = host.instance.open(guest.descriptor, '7')
	expect(Object.keys(view).sort()).toEqual(['generation', 'height', 'id', 'url', 'width'])
	expect(JSON.stringify(view)).not.toContain(bearer)
	expect(view.url).toMatch(/^ws:\/\/127\.0\.0\.1:[1-9][0-9]*\/stream\/[a-f0-9]{64}$/)
	const socket = await ready(view.url)
	expect(guest.connections).toHaveLength(1)
	expect(guest.connections[0]?.authorization).toBe(bearer)
	const payload = Buffer.from([0, 255, 17, 0, 128, 42])
	const received = once(guest.connections[0]!.socket, 'message')
	socket.send(payload, { binary: true })
	const [bytes, binary] = await received
	expect(binary).toBe(true)
	expect(Buffer.from(bytes)).toEqual(payload)
	const displayed = once(socket, 'message')
	guest.connections[0]!.socket.send(payload, { binary: true })
	const [pixels, pixelsBinary] = await displayed
	expect(pixelsBinary).toBe(true)
	expect(Buffer.from(pixels)).toEqual(payload)
	expect(host.failure).not.toHaveBeenCalled()
})

it('rejects wrong Origin, ticket and Host before opening an upstream connection', async () => {
	const guest = await upstream()
	const host = await proxy()
	const view = host.instance.open(guest.descriptor, '7')
	await rejected(viewer(view.url, 'https://untrusted.example'))
	await rejected(viewer(view.url, null))
	const missing = new URL(view.url)
	missing.pathname = `/stream/${'0'.repeat(64)}`
	await rejected(viewer(missing.toString()))
	await rejected(viewer(view.url, origin, `localhost:${host.port}`))
	expect(guest.connections).toHaveLength(0)
	// Failed attempts must not consume the valid observation ticket.
	await ready(view.url)
	expect(guest.connections).toHaveLength(1)
})

it('accepts the native Chromium file origin while refusing null, missing and foreign origins', async () => {
	const guest = await upstream()
	const host = await proxy()
	host.instance.allowRenderer('file:///C:/Namzu/renderer/index.html')
	const view = host.instance.open(guest.descriptor, '7')
	for (const wrong of ['null', null, origin, 'https://untrusted.example', 'file://untrusted'])
		await rejected(viewer(view.url, wrong))
	await rejected(viewer(view.url, 'file://', `localhost:${host.port}`))
	expect(guest.connections).toHaveLength(0)
	await ready(view.url, 'file://')
	expect(guest.connections).toHaveLength(1)
	expect(guest.connections[0]?.authorization).toBe(bearer)
})

it('allows one viewer per ticket and closes the allocation view without reporting deliberate shutdown', async () => {
	const guest = await upstream()
	const host = await proxy()
	const view = host.instance.open(guest.descriptor, '7')
	const socket = await ready(view.url)
	await rejected(viewer(view.url))
	expect(guest.connections).toHaveLength(1)
	const closed = once(socket, 'close')
	host.instance.close(view.id)
	await closed
	await rejected(viewer(view.url))
	expect(host.failure).not.toHaveBeenCalled()
})

it('captures immutable allocation metadata when creating the renderer view', async () => {
	const guest = await upstream()
	const host = await proxy()
	const view = host.instance.open(guest.descriptor, '7')
	guest.descriptor.url = 'ws://127.0.0.1:1/stream'
	guest.descriptor.authorization = `Bearer ${'b'.repeat(64)}`
	view.width = 99
	await ready(view.url)
	expect(guest.connections[0]?.authorization).toBe(bearer)
	const socket = guest.connections[0]!.socket
	expect(socket.readyState).toBe(WebSocket.OPEN)
})

it('rejects unsafe or stale descriptors with a secret-free error', async () => {
	const guest = await upstream()
	const host = await proxy()
	const secret = 'PRIVATE_ALLOCATION_SECRET'
	for (const raw of [
		null,
		{},
		{ ...guest.descriptor, protocol: 'unknown' },
		{ ...guest.descriptor, generation: '6' },
		{ ...guest.descriptor, url: `wss://private-${secret}.example/stream` },
		{ ...guest.descriptor, url: `ws://${secret}@127.0.0.1:1234/stream` },
		{ ...guest.descriptor, url: `${guest.descriptor.url}?token=${secret}` },
		{ ...guest.descriptor, url: `${guest.descriptor.url}#${secret}` },
		{ ...guest.descriptor, url: 'ws://127.0.0.1:0/stream' },
		{ ...guest.descriptor, url: new URL(guest.descriptor.url) },
		{ ...guest.descriptor, authorization: `Bearer ${secret}\r\nX-Injected: bad` },
		{ ...guest.descriptor, width: 4097 },
		{ ...guest.descriptor, height: 0 },
	]) {
		let caught: unknown
		try {
			host.instance.open(raw, '7')
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(Error)
		expect((caught as Error).message).toBe('Invalid computer stream.')
		expect(String(caught)).not.toContain(secret)
	}
	expect(guest.connections).toHaveLength(0)
})

it('rejects text viewer frames before they can reach the live upstream byte stream', async () => {
	const guest = await upstream()
	const host = await proxy()
	const view = host.instance.open(guest.descriptor, '7')
	const socket = await ready(view.url)
	const closed = once(socket, 'close')
	const guestClosed = once(guest.connections[0]!.socket, 'close')
	socket.send('invalid-text-frame')
	await closed
	await guestClosed
	expect(guest.connections[0]?.bytes).toEqual([])
	expect(host.failure).toHaveBeenCalledTimes(1)
})

it('rejects text upstream frames before they can be shown as framebuffer bytes', async () => {
	const guest = await upstream()
	const host = await proxy()
	const view = host.instance.open(guest.descriptor, '7')
	const socket = await ready(view.url)
	const received: Buffer[] = []
	socket.on('message', (bytes) => received.push(Buffer.from(bytes as Buffer)))
	const closed = once(socket, 'close')
	guest.connections[0]!.socket.send('invalid-guest-text')
	await closed
	expect(received).toEqual([])
	expect(host.failure).toHaveBeenCalledTimes(1)
})

it('shuts down its listener even with an unfinished ordinary HTTP request and refuses restart', async () => {
	const host = await proxy()
	const socket = connect({ host: '127.0.0.1', port: host.port })
	rawSockets.push(socket)
	socket.on('error', () => {})
	await once(socket, 'connect')
	await new Promise<void>((resolve, reject) =>
		socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n', (error) =>
			error ? reject(error) : resolve(),
		),
	)
	// Destroying a partial request may reset the client socket; its close is the owned outcome.
	const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
	await host.instance.shutdown()
	await closed
	await expect(host.instance.start()).rejects.toThrow('The computer viewer is closed.')
	expect(host.failure).not.toHaveBeenCalled()
})
