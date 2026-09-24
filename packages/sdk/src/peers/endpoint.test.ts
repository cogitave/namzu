import { lstatSync, mkdtempSync, writeFileSync } from 'node:fs'
import { type Server, type Socket, createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { PeerClient } from './client.js'
import {
	type CreatePeerEndpointOptions,
	type PeerEndpoint,
	PeerEndpointError,
	createPeerEndpoint,
} from './endpoint.js'
import { PEER_PROTOCOL_VERSION } from './protocol.js'
import { PEER_RECORD_VERSION, type PeerRecord } from './record.js'
import { writePeerRecord } from './registry.js'

const dirs: string[] = []
const endpoints: PeerEndpoint[] = []
const deadListeners: { server: Server; sockets: Set<Socket> }[] = []
afterEach(async () => {
	await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()))
	await Promise.all(
		deadListeners.splice(0).map(({ server, sockets }) => {
			for (const socket of sockets) socket.destroy()
			return new Promise<void>((resolve) => server.close(() => resolve()))
		}),
	)
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

/**
 * A raw listener that accepts a connection at the OS level but never reads
 * or responds — standing in for a socket file left behind by a process that
 * exited without cleaning up: the name exists, `isSocket()` is true, it is
 * owned by this uid, and no `namzu-peer/1` response ever arrives.
 */
function startDeadListener(path: string): Promise<Server> {
	return new Promise((resolve, reject) => {
		const sockets = new Set<Socket>()
		const server = createServer((socket) => {
			// Accept and ignore: this is what "nothing answers" looks like. An
			// error handler is required — otherwise the remote side destroying
			// its end of the connection throws here instead of just closing it.
			socket.on('error', () => {})
			sockets.add(socket)
			socket.once('close', () => sockets.delete(socket))
		})
		server.once('error', reject)
		server.listen(path, () => {
			server.removeListener('error', reject)
			deadListeners.push({ server, sockets })
			resolve(server)
		})
	})
}

function socketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-peers-endpoint-test-'))
	dirs.push(dir)
	return join(dir, 'sess.sock')
}

async function start(overrides: Partial<CreatePeerEndpointOptions> = {}): Promise<PeerEndpoint> {
	const endpoint = await createPeerEndpoint({
		address: `uds:${socketPath()}`,
		token: 't'.repeat(32),
		uid: process.getuid?.(),
		getState: () => 'idle',
		onDeliver: () => ({ status: 'queued' }),
		onSubscribeIdle: () => ({ status: 'subscribed' }),
		onNotice: () => {},
		...overrides,
	})
	endpoints.push(endpoint)
	return endpoint
}

function connect(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path })
		socket.once('connect', () => resolve(socket))
		socket.once('error', reject)
	})
}

function waitForClose(socket: Socket, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		if (socket.destroyed) {
			resolve(true)
			return
		}
		const timer = setTimeout(() => {
			socket.removeListener('close', onClose)
			resolve(false)
		}, timeoutMs)
		const onClose = (): void => {
			clearTimeout(timer)
			resolve(true)
		}
		socket.once('close', onClose)
	})
}

function pathOf(address: string): string {
	return address.slice('uds:'.length)
}

function makeFrom(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		sessionId: 'sender-1',
		ref: 'aaaaaa',
		name: 'alice',
		address: 'uds:/tmp/sender-1.sock',
		mode: 'default',
		kind: 'tui' as const,
		...overrides,
	}
}

describe('createPeerEndpoint: transport basics', () => {
	it('chmods the socket 0600 right after listen', async () => {
		const endpoint = await start()
		expect(lstatSync(pathOf(endpoint.address)).mode & 0o777).toBe(0o600)
	})

	it('answers ping with the current state, unauthenticated', async () => {
		const endpoint = await start({ getState: () => 'busy' })
		const client = new PeerClient()
		await expect(client.ping(endpoint.address)).resolves.toEqual({
			kind: 'responded',
			ok: true,
			state: 'busy',
		})
	})

	it('refuses a request with the wrong token: no response, connection destroyed', async () => {
		const endpoint = await start()
		const client = new PeerClient()
		const result = await client.deliver(
			{ address: endpoint.address, token: 'not-the-right-token'.padEnd(32, 'x') },
			{ id: 'm1', from: makeFrom(), text: 'hi' },
		)
		expect(result.kind).toBe('unreachable')
	})

	it('refuses a request outside the closed op set', async () => {
		const endpoint = await start()
		const socket = await connect(pathOf(endpoint.address))
		const closed = waitForClose(socket, 1_000)
		socket.write(`${JSON.stringify({ protocol: PEER_PROTOCOL_VERSION, op: 'shutdown' })}\n`)
		expect(await closed).toBe(true)
	})

	it('refuses malformed JSON', async () => {
		const endpoint = await start()
		const socket = await connect(pathOf(endpoint.address))
		const closed = waitForClose(socket, 1_000)
		socket.write('not json at all\n')
		expect(await closed).toBe(true)
	})

	it('refuses a request over the byte cap', async () => {
		const endpoint = await start({ maxRequestBytes: 200 })
		const socket = await connect(pathOf(endpoint.address))
		const closed = waitForClose(socket, 1_000)
		socket.write('x'.repeat(500))
		expect(await closed).toBe(true)
	})

	it('refuses more than one line per connection', async () => {
		const endpoint = await start()
		const socket = await connect(pathOf(endpoint.address))
		const closed = waitForClose(socket, 1_000)
		const ping = `${JSON.stringify({ protocol: PEER_PROTOCOL_VERSION, op: 'ping' })}\n`
		socket.write(ping + ping)
		expect(await closed).toBe(true)
	})

	it('drops a connection that never completes a line within the read deadline', async () => {
		const endpoint = await start({ readDeadlineMs: 50 })
		const socket = await connect(pathOf(endpoint.address))
		const closed = waitForClose(socket, 1_000)
		// Never send anything.
		expect(await closed).toBe(true)
	})

	it('enforces the maximum concurrent connection count', async () => {
		const endpoint = await start({ maxConnections: 2 })
		const path = pathOf(endpoint.address)
		const first = await connect(path)
		const second = await connect(path)
		const third = await connect(path)
		const thirdClosed = await waitForClose(third, 500)
		expect(thirdClosed).toBe(true)
		// The two within budget are unaffected.
		expect(await waitForClose(first, 100)).toBe(false)
		expect(await waitForClose(second, 100)).toBe(false)
		first.destroy()
		second.destroy()
	})
})

describe('createPeerEndpoint: deliver / subscribe_idle / notice', () => {
	it('deliver: calls onDeliver and returns its result once the sender is verified', async () => {
		let received: unknown
		const endpoint = await start({
			verifySender: () => true,
			onDeliver: (request) => {
				received = request.text
				return { status: 'held', reason: 'modes differ' }
			},
		})
		const client = new PeerClient()
		const result = await client.deliver(
			{ address: endpoint.address, token: 't'.repeat(32) },
			{ id: 'm1', from: makeFrom(), text: 'build is green' },
		)
		expect(result).toEqual({ kind: 'responded', status: 'held', reason: 'modes differ' })
		expect(received).toBe('build is green')
	})

	it('deliver: refuses when the sender cannot be verified, without calling onDeliver', async () => {
		let called = false
		const endpoint = await start({
			verifySender: () => false,
			onDeliver: () => {
				called = true
				return { status: 'queued' }
			},
		})
		const client = new PeerClient()
		const result = await client.deliver(
			{ address: endpoint.address, token: 't'.repeat(32) },
			{ id: 'm1', from: makeFrom(), text: 'hi' },
		)
		expect(result).toEqual({
			kind: 'responded',
			status: 'refused',
			reason: 'sender identity could not be verified',
		})
		expect(called).toBe(false)
	})

	it('subscribe_idle: calls onSubscribeIdle once verified', async () => {
		const endpoint = await start({
			verifySender: () => true,
			onSubscribeIdle: () => ({ status: 'subscribed' }),
		})
		const client = new PeerClient()
		await expect(
			client.subscribeIdle(
				{ address: endpoint.address, token: 't'.repeat(32) },
				{ id: 'm1', from: makeFrom() },
			),
		).resolves.toEqual({ kind: 'responded', status: 'subscribed' })
	})

	it('subscribe_idle: refuses when unverified, with no reason field (closed response shape)', async () => {
		const endpoint = await start({ verifySender: () => false })
		const client = new PeerClient()
		await expect(
			client.subscribeIdle(
				{ address: endpoint.address, token: 't'.repeat(32) },
				{ id: 'm1', from: makeFrom() },
			),
		).resolves.toEqual({ kind: 'responded', status: 'refused' })
	})

	it('notice: calls onNotice and answers ok, without a sender to verify', async () => {
		let seenKind: string | undefined
		const endpoint = await start({
			onNotice: (request) => {
				seenKind = request.kind
			},
		})
		const client = new PeerClient()
		await expect(
			client.notice(
				{ address: endpoint.address, token: 't'.repeat(32) },
				{ kind: 'idle', about: { sessionId: 'sess-2', name: 'bob', ref: 'bbbbbb' } },
			),
		).resolves.toEqual({ kind: 'responded', ok: true })
		expect(seenKind).toBe('idle')
	})
})

describe('createPeerEndpoint: default verifySender', () => {
	function registryDir(): string {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-peers-endpoint-registry-'))
		dirs.push(dir)
		return dir
	}

	function senderRecord(overrides: Partial<PeerRecord> = {}): PeerRecord {
		return {
			v: PEER_RECORD_VERSION,
			sessionId: 'sender-1',
			ref: 'aaaaaa',
			pid: process.pid, // this test process is verifiably alive
			startedAt: Date.now(),
			kind: 'tui',
			cwd: '/home/user/project',
			permissionMode: 'default',
			state: 'idle',
			acceptsMessages: true,
			address: '',
			token: 's'.repeat(32),
			protocol: PEER_PROTOCOL_VERSION,
			cliVersion: '1.0.0',
			...overrides,
		}
	}

	it('verifies a sender whose registry record exists, is live, and matches from.address', async () => {
		const sessionsDir = registryDir()
		const senderPath = socketPath()
		// The "sender" endpoint: something a ping can reach at the claimed address.
		const senderEndpoint = await start({ address: `uds:${senderPath}`, getState: () => 'idle' })
		writePeerRecord(sessionsDir, senderRecord({ address: senderEndpoint.address }))

		const recipient = await start({ sessionsDir })
		const client = new PeerClient()
		const result = await client.deliver(
			{ address: recipient.address, token: 't'.repeat(32) },
			{ id: 'm1', from: makeFrom({ address: senderEndpoint.address }), text: 'hi' },
		)
		expect(result).toEqual({ kind: 'responded', status: 'queued' })
	})

	it('refuses a spoofed from.address: the claimed address does not match the registry record', async () => {
		const sessionsDir = registryDir()
		const senderPath = socketPath()
		const senderEndpoint = await start({ address: `uds:${senderPath}`, getState: () => 'idle' })
		writePeerRecord(sessionsDir, senderRecord({ address: senderEndpoint.address }))

		const recipient = await start({ sessionsDir })
		const client = new PeerClient()
		const result = await client.deliver(
			{ address: recipient.address, token: 't'.repeat(32) },
			// Claims the real sessionId/ref but a DIFFERENT address than its own record.
			{ id: 'm1', from: makeFrom({ address: 'uds:/tmp/somewhere-else.sock' }), text: 'hi' },
		)
		expect(result).toEqual({
			kind: 'responded',
			status: 'refused',
			reason: 'sender identity could not be verified',
		})
	})

	it('refuses a sender with no registry record at all', async () => {
		const recipient = await start({ sessionsDir: registryDir() })
		const client = new PeerClient()
		const result = await client.deliver(
			{ address: recipient.address, token: 't'.repeat(32) },
			{ id: 'm1', from: makeFrom(), text: 'hi' },
		)
		expect(result).toEqual({
			kind: 'responded',
			status: 'refused',
			reason: 'sender identity could not be verified',
		})
	})

	it('refuses when verifySender is neither supplied nor backed by a sessionsDir', async () => {
		const recipient = await start()
		const client = new PeerClient()
		const result = await client.deliver(
			{ address: recipient.address, token: 't'.repeat(32) },
			{ id: 'm1', from: makeFrom(), text: 'hi' },
		)
		expect(result).toEqual({
			kind: 'responded',
			status: 'refused',
			reason: 'sender identity could not be verified',
		})
	})
})

describe('createPeerEndpoint: binding and stale sockets', () => {
	it('refuses to bind where a live process already listens', async () => {
		const endpoint = await start()
		await expect(
			createPeerEndpoint({
				address: endpoint.address,
				token: 't'.repeat(32),
				uid: process.getuid?.(),
				getState: () => 'idle',
				onDeliver: () => ({ status: 'queued' }),
				onSubscribeIdle: () => ({ status: 'subscribed' }),
				onNotice: () => {},
			}),
		).rejects.toThrow(PeerEndpointError)
	})

	it('removes a stale socket (nothing answers) and binds over it', async () => {
		const path = socketPath()
		await startDeadListener(path)
		const endpoint = await start({ address: `uds:${path}` })
		const client = new PeerClient()
		await expect(client.ping(endpoint.address)).resolves.toMatchObject({ kind: 'responded' })
	})

	it('refuses to bind where a non-socket file already exists', async () => {
		const path = socketPath()
		writeFileSync(path, 'not a socket')
		await expect(
			createPeerEndpoint({
				address: `uds:${path}`,
				token: 't'.repeat(32),
				uid: process.getuid?.(),
				getState: () => 'idle',
				onDeliver: () => ({ status: 'queued' }),
				onSubscribeIdle: () => ({ status: 'subscribed' }),
				onNotice: () => {},
			}),
		).rejects.toThrow(PeerEndpointError)
	})

	it('refuses to remove a stale socket owned by a different uid', async () => {
		const uid = process.getuid?.()
		if (uid === undefined) return // win32 models no uid to mismatch.
		const path = socketPath()
		await startDeadListener(path)
		await expect(
			createPeerEndpoint({
				address: `uds:${path}`,
				token: 't'.repeat(32),
				uid: uid + 999_999,
				getState: () => 'idle',
				onDeliver: () => ({ status: 'queued' }),
				onSubscribeIdle: () => ({ status: 'subscribed' }),
				onNotice: () => {},
			}),
		).rejects.toThrow(PeerEndpointError)
	})
})
