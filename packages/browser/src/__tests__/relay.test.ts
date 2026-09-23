import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { type CdpRelay, type CdpRelayPeer, startCdpRelay } from '../relay.js'

/** A bridge stand-in that answers every message with `{"echo":<message>}`. */
function echoPeer(): CdpRelayPeer & { sent: string[] } {
	let listener: ((message: Buffer) => void) | undefined
	const sent: string[] = []
	return {
		sent,
		send(message) {
			const text = message.toString()
			sent.push(text)
			setImmediate(() => listener?.(Buffer.from(`{"echo":${text}}`)))
			return true
		},
		onMessage(next) {
			listener = next
		},
	}
}

function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url, { headers, maxPayload: 256 * 1024 * 1024 })
		ws.once('open', () => resolve(ws))
		ws.once('error', reject)
		ws.once('unexpected-response', (_request, response) =>
			reject(new Error(`HTTP ${response.statusCode}`)),
		)
	})
}

function nextMessage(ws: WebSocket): Promise<string> {
	return new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())))
}

let relay: CdpRelay | undefined
const clients: WebSocket[] = []

afterEach(async () => {
	for (const ws of clients.splice(0)) ws.terminate()
	await relay?.close()
	relay = undefined
})

describe('startCdpRelay', () => {
	it('listens on 127.0.0.1 at a 64-hex-digit path', async () => {
		relay = await startCdpRelay(echoPeer())
		expect(relay.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}$/)
	})

	it('refuses any other path, before any WebSocket is made', async () => {
		const peer = echoPeer()
		relay = await startCdpRelay(peer)
		const base = relay.url.replace(/\/[0-9a-f]{64}$/, '')
		const token = relay.url.slice(base.length + 1)
		await expect(open(`${base}/`)).rejects.toThrow(/HTTP 404/)
		await expect(open(`${base}/devtools/browser/x`)).rejects.toThrow(/HTTP 404/)
		// One hex digit off. Always a different digit: replacing the last one
		// with a fixed `0` was the real token whenever it already ended in 0,
		// one run in sixteen.
		const last = token.at(-1) === '0' ? '1' : '0'
		await expect(open(`${base}/${token.slice(0, -1)}${last}`)).rejects.toThrow(/HTTP 404/)
		await expect(open(`${base}/${token}/`)).rejects.toThrow(/HTTP 404/)
		await expect(open(`${base}/${token}?x=1`)).rejects.toThrow(/HTTP 404/)
		const plain = await fetch(`${base.replace('ws:', 'http:')}/${token}`)
		expect(plain.status).toBe(404)
		expect(peer.sent).toEqual([])
	})

	it('refuses a request from a web page (Origin header) and a second client', async () => {
		relay = await startCdpRelay(echoPeer())
		await expect(open(relay.url, { Origin: 'http://evil.example' })).rejects.toThrow(/HTTP 403/)
		const first = await open(relay.url)
		clients.push(first)
		await expect(open(relay.url)).rejects.toThrow(/HTTP 409/)
	})

	it('relays both ways, a multi-megabyte message intact', async () => {
		const peer = echoPeer()
		relay = await startCdpRelay(peer)
		const ws = await open(relay.url)
		clients.push(ws)
		ws.send('{"id":1,"method":"Browser.getVersion"}')
		expect(await nextMessage(ws)).toBe('{"echo":{"id":1,"method":"Browser.getVersion"}}')

		const data = randomBytes(6 * 1024 * 1024).toString('base64')
		const big = JSON.stringify({ id: 2, result: { data } })
		const reply = nextMessage(ws)
		ws.send(big)
		const text = await reply
		expect(text.length).toBe(big.length + '{"echo":}'.length)
		expect(JSON.parse(text).echo.result.data).toBe(data)
	})

	it('drops the client when closed', async () => {
		relay = await startCdpRelay(echoPeer())
		const ws = await open(relay.url)
		const closed = new Promise((resolve) => ws.once('close', resolve))
		await relay.close()
		relay = undefined
		await closed
	})
})
