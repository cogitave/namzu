import { mkdtempSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { PeerClient, pingPeer } from './client.js'
import { PEER_PROTOCOL_VERSION } from './protocol.js'

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	)
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function socketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-peers-client-test-'))
	dirs.push(dir)
	return join(dir, 'sess.sock')
}

/** A minimal raw server: reads one line per connection and hands it, and the socket, to `handler`. */
function startRawServer(
	path: string,
	handler: (request: unknown, socket: Socket) => void,
): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer((socket) => {
			let buffered = Buffer.alloc(0)
			socket.on('data', (chunk: Buffer) => {
				buffered = Buffer.concat([buffered, chunk])
				const newline = buffered.indexOf(10)
				if (newline < 0) return
				const request: unknown = JSON.parse(buffered.subarray(0, newline).toString('utf8'))
				handler(request, socket)
			})
		})
		server.once('error', reject)
		server.listen(path, () => {
			server.removeListener('error', reject)
			servers.push(server)
			resolve(server)
		})
	})
}

describe('pingPeer', () => {
	it('resolves true when the peer answers ping', async () => {
		const path = socketPath()
		await startRawServer(path, (_request, socket) => {
			socket.end(`${JSON.stringify({ ok: true, state: 'idle' })}\n`)
		})
		await expect(pingPeer(`uds:${path}`, 500)).resolves.toBe(true)
	})

	it('sends no token: a ping request carries only protocol and op', async () => {
		const path = socketPath()
		let seen: unknown
		await startRawServer(path, (request, socket) => {
			seen = request
			socket.end(`${JSON.stringify({ ok: true, state: 'idle' })}\n`)
		})
		await pingPeer(`uds:${path}`, 500)
		expect(seen).toEqual({ protocol: PEER_PROTOCOL_VERSION, op: 'ping' })
	})

	it('resolves false when nothing is listening at the address', async () => {
		const path = socketPath() // never bound
		await expect(pingPeer(`uds:${path}`, 300)).resolves.toBe(false)
	})

	it('resolves false when the server never answers before the timeout', async () => {
		const path = socketPath()
		await startRawServer(path, () => {
			/* never respond */
		})
		await expect(pingPeer(`uds:${path}`, 100)).resolves.toBe(false)
	})

	it('resolves false for a response that fails schema validation', async () => {
		const path = socketPath()
		await startRawServer(path, (_request, socket) => {
			socket.end(`${JSON.stringify({ ok: 'not a boolean' })}\n`)
		})
		await expect(pingPeer(`uds:${path}`, 500)).resolves.toBe(false)
	})
})

describe('PeerClient', () => {
	it('ping: returns the responded result with the peer state', async () => {
		const path = socketPath()
		await startRawServer(path, (_request, socket) => {
			socket.end(`${JSON.stringify({ ok: true, state: 'busy' })}\n`)
		})
		const client = new PeerClient()
		await expect(client.ping(`uds:${path}`)).resolves.toEqual({
			kind: 'responded',
			ok: true,
			state: 'busy',
		})
	})

	it('ping: unreachable when the connection is refused', async () => {
		const client = new PeerClient()
		const result = await client.ping(`uds:${socketPath()}`, 300)
		expect(result.kind).toBe('unreachable')
	})

	it('ping: unreachable for an a2a: address, without throwing', async () => {
		const client = new PeerClient()
		const result = await client.ping('a2a:https://example.com/agent')
		expect(result.kind).toBe('unreachable')
	})

	it('deliver: sends the recipient token from the record, not from the message', async () => {
		const path = socketPath()
		let seenToken: unknown
		await startRawServer(path, (request, socket) => {
			seenToken = (request as { token?: unknown }).token
			socket.end(`${JSON.stringify({ status: 'queued' })}\n`)
		})
		const client = new PeerClient()
		const from = {
			sessionId: 'sess-a',
			ref: 'aaaaaa',
			name: 'alice',
			address: 'uds:/tmp/a.sock',
			mode: 'default',
			kind: 'tui' as const,
		}
		const result = await client.deliver(
			{ address: `uds:${path}`, token: 'recipient-token' },
			{ id: 'm1', from, text: 'hi' },
		)
		expect(seenToken).toBe('recipient-token')
		expect(result).toEqual({ kind: 'responded', status: 'queued' })
	})

	it('subscribeIdle: round trip', async () => {
		const path = socketPath()
		await startRawServer(path, (_request, socket) => {
			socket.end(`${JSON.stringify({ status: 'subscribed' })}\n`)
		})
		const client = new PeerClient()
		const from = {
			sessionId: 'sess-a',
			ref: 'aaaaaa',
			name: 'alice',
			address: 'uds:/tmp/a.sock',
			mode: 'default',
			kind: 'tui' as const,
		}
		await expect(
			client.subscribeIdle({ address: `uds:${path}`, token: 't' }, { id: 'm1', from }),
		).resolves.toEqual({ kind: 'responded', status: 'subscribed' })
	})

	it('notice: round trip', async () => {
		const path = socketPath()
		await startRawServer(path, (_request, socket) => {
			socket.end(`${JSON.stringify({ ok: true })}\n`)
		})
		const client = new PeerClient()
		await expect(
			client.notice(
				{ address: `uds:${path}`, token: 't' },
				{ kind: 'idle', about: { sessionId: 'sess-b', name: 'bob', ref: 'bbbbbb' } },
			),
		).resolves.toEqual({ kind: 'responded', ok: true })
	})

	it('resolves unreachable for a response over the size limit', async () => {
		const path = socketPath()
		await startRawServer(path, (_request, socket) => {
			// No newline: the client keeps buffering until it exceeds the cap.
			socket.write('x'.repeat(70 * 1024))
		})
		const client = new PeerClient({ timeoutMs: 2_000 })
		const result = await client.ping(`uds:${path}`)
		expect(result.kind).toBe('unreachable')
	})
})
