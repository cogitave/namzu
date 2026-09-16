/**
 * The guest agent's per-instance credential gate.
 *
 * A guest on a routed network is reachable by whatever the network
 * admits, so the pod-network deployment starts `agent/agent.cjs` with a
 * per-instance token and the agent refuses every op but `healthz` that
 * does not present it. Two modes, both opt-in through the environment:
 * `NAMZU_AGENT_BIND_TOKEN` (the pod's own `metadata.uid`, injected by
 * the downward API and learned by the host from the API server) and, as
 * a fallback for a deployment that cannot inject one,
 * `NAMZU_AGENT_REQUIRE_TOKEN` — trust the first token seen, refuse
 * every other one for the life of the process.
 *
 * With neither set the agent authenticates nothing, which is the
 * Firecracker vsock/unix path and is asserted here rather than assumed:
 * this file is the same guest that tier bakes into its golden image.
 *
 * These cases drive the real agent's `handleConnection` over a loopback
 * socket, so the gate is exercised where it actually sits — in front of
 * dispatch, on the first frame of a connection, before any handler has
 * spawned a process or touched the workspace.
 */

import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, type Socket, connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import { decodeFrames, encodeFrame, sendFramedRequest } from './fixtures/framed-agent-client.js'

const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'

/** A pod uid is what the downward API actually delivers; shaped like one. */
const POD_UID = '6f0b5d2e-2f3a-4b8c-9d1e-77aa0c4f1b32'
const OTHER_UID = 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f'

interface AgentModule {
	AGENT_FEATURES: string[]
	FIRECRACKER_AGENT_PROTOCOL_VERSION: number
	handleConnection(socket: Socket): void
}

// Every knob the agent reads, not the handful this file sets: the agent
// reads them at module load, so one left over from the ambient shell
// decides a case here just as firmly as one a case sets on purpose.
// `NAMZU_TEST_MARKER` is not one of the agent's — it is this file's own
// proof that a spawned child inherits an environment at all.
const MANAGED_ENV = [...AGENT_ENV_KEYS, 'NAMZU_TEST_MARKER'] as const

/** The agent's own side of one accepted connection, and when it ended. */
interface AcceptedConnection {
	readonly socket: Socket
	readonly closed: Promise<unknown>
}

let workDir: string
let server: Server
let port: number
let agent: AgentModule
let accepted: AcceptedConnection[]
let servers: Server[] = []
let clients: Socket[] = []
let drips: ReturnType<typeof setInterval>[] = []
let saved: Record<string, string | undefined>

function clearEnv(keys: readonly string[]): void {
	for (const key of keys) {
		// Unset, not emptied: the agent reads these straight off
		// process.env, where an empty string is not the same as absent.
		delete process.env[key]
	}
}

/**
 * Load a FRESH agent module and put it behind a loopback listener. Fresh
 * matters: the trust-on-first-use binding is module-level process state,
 * so a stale module would carry one case's binding into the next.
 */
async function startAgent(): Promise<void> {
	delete require_.cache[require_.resolve(AGENT_PATH)]
	agent = require_(AGENT_PATH) as AgentModule
	accepted = []
	server = createServer((socket) => {
		// Captured before the agent sees it, so a case can ask what the
		// AGENT's own socket did — whether it was destroyed, and how many
		// bytes it ever read — rather than inferring it from the client.
		accepted.push({ socket, closed: once(socket, 'close') })
		agent.handleConnection(socket)
	})
	servers.push(server)
	await new Promise<void>((resolve, reject) => {
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => resolve())
	})
	port = (server.address() as AddressInfo).port
}

/** How many connections the listener is still holding open. */
async function liveConnections(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		server.getConnections((error, count) => (error ? reject(error) : resolve(count)))
	})
}

/**
 * Dial the agent and hand back a raw socket. Unlike `sendFramedRequest`
 * these cases keep writing after the agent has answered, so they own the
 * socket rather than awaiting a completed exchange.
 *
 * `allowHalfOpen` is what makes that possible, and it is also what makes
 * these cases faithful: a default client answers the agent's FIN with one
 * of its own and stops writing, which is precisely the hostile peer this
 * file is not interested in. A peer that ignores the FIN and keeps
 * sending is the case a half-closed refusal used to serve indefinitely.
 */
async function dial(): Promise<Socket> {
	const before = accepted.length
	const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true })
	clients.push(socket)
	// A refused peer is told so and then cut off, so every write after
	// that point fails; the failures are the point, not an error.
	socket.on('error', () => {})
	await once(socket, 'connect')
	// The client's `connect` fires on the handshake, which on loopback can
	// land a turn AHEAD of the listener's `connection` event — so a case
	// that reads `accepted.at(-1)` straight after a dial is reading a race
	// it usually wins. Wait for the agent's own side to exist instead.
	for (let waited = 0; accepted.length === before; waited += 1) {
		if (waited > 1_000) throw new Error('the listener never accepted the dialled connection')
		await delay(1)
	}
	return socket
}

/**
 * Dial the agent and hold the connection the way a slow loris does: one
 * whole, legitimate frame header, then one body byte at a time, for as
 * long as the case runs.
 *
 * The header is not decoration. A frame header is fixed-width — nine
 * bytes, eight hex digits and a newline — so a peer that trickles
 * arbitrary bytes is refused on the ninth of them and never reaches the
 * window this shape is about. Announcing a body and then dripping it is
 * what actually keeps a connection unauthenticated and alive, and every
 * one of those bytes resets an idle timer, which is precisely why an idle
 * timer is not a bound.
 */
async function trickle(everyMs = 10): Promise<Socket> {
	const socket = await dial()
	socket.write(Buffer.from('00100000\n', 'ascii'))
	const drip = setInterval(() => {
		if (!socket.destroyed) socket.write(Buffer.from('a', 'ascii'))
	}, everyMs)
	drip.unref()
	drips.push(drip)
	return socket
}

/** Resolve with the first whole frame the agent writes back. */
async function firstFrame(socket: Socket): Promise<Record<string, unknown>> {
	return await new Promise<Record<string, unknown>>((resolve, reject) => {
		let buffered = Buffer.alloc(0)
		const timer = setTimeout(() => reject(new Error('no frame within 10s')), 10_000)
		timer.unref()
		socket.on('data', (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk])
			const { frames } = decodeFrames(buffered)
			if (frames.length === 0) return
			clearTimeout(timer)
			resolve(JSON.parse(frames[0] as string) as Record<string, unknown>)
		})
		socket.once('close', () => {
			clearTimeout(timer)
			reject(new Error('closed before any frame arrived'))
		})
	})
}

/** Push `mib` MiB at the agent, ignoring back-pressure. */
function flood(socket: Socket, mib: number): void {
	const block = Buffer.alloc(256 * 1024, 0x61)
	for (let written = 0; written < mib * 4; written += 1) socket.write(block)
}

/**
 * Wait for the agent to take a connection down, and say what went wrong
 * if it never does — a bare await here fails as "test timed out", which
 * names the symptom and not the defect.
 */
async function expectAgentClosed(connection: AcceptedConnection): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error('the agent left the connection open instead of destroying it')),
			5_000,
		)
	})
	try {
		await Promise.race([connection.closed, expired])
	} finally {
		clearTimeout(timer)
	}
}

/** A request the gate must refuse or admit — a real op, not a probe. */
function readFileRequest(token?: string): Record<string, unknown> {
	return {
		op: 'read-file',
		...(token === undefined ? {} : { token }),
		body: { path: join(workDir, 'secret.txt'), encoding: 'base64' },
	}
}

beforeEach(() => {
	saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]))
	clearEnv(MANAGED_ENV)
	servers = []
	clients = []
	drips = []
	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-agent-token-')))
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
})

afterEach(async () => {
	for (const drip of drips) clearInterval(drip)
	for (const socket of clients) socket.destroy()
	// Every listener a case started, not just the last: a case that
	// reloads the agent under a different environment starts a second one.
	for (const listener of servers) {
		await new Promise<void>((resolve) => listener.close(() => resolve()))
	}
	clearEnv(MANAGED_ENV)
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	rmSync(workDir, { recursive: true, force: true })
})

async function writeSecret(token?: string): Promise<void> {
	const written = await sendFramedRequest(port, {
		op: 'write-file',
		...(token === undefined ? {} : { token }),
		body: {
			path: join(workDir, 'secret.txt'),
			content: Buffer.from('workspace content', 'utf8').toString('base64'),
			encoding: 'base64',
		},
	})
	expect(written.reply).toEqual({ ok: true, bytesWritten: 17 })
}

describe('preset per-instance token', () => {
	beforeEach(async () => {
		process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
		await startAgent()
	})

	it('admits the pod uid from the very first frame of a connection', async () => {
		await writeSecret(POD_UID)

		const read = await sendFramedRequest(port, readFileRequest(POD_UID))

		expect(read.reply.ok).toBe(true)
		expect(Buffer.from(String(read.reply.content), 'base64').toString('utf8')).toBe(
			'workspace content',
		)
	})

	it('refuses another instance token and closes the connection', async () => {
		await writeSecret(POD_UID)

		const read = await sendFramedRequest(port, readFileRequest(OTHER_UID))

		expect(read.reply).toEqual({ ok: false, error: 'unauthorized' })
		expect(read.frames).toHaveLength(1)
		expect(read.closedByAgent).toBe(true)
	})

	// Length safety itself lives in the digest comparison — this asserts
	// the outcome that comparison has to produce: a longer and a shorter
	// token are refused like any other wrong one, neither throwing nor
	// short-circuiting on the length.
	it('refuses tokens longer and shorter than the expected one', async () => {
		const read = await sendFramedRequest(port, readFileRequest(`${POD_UID}-and-then-some`))
		const truncated = await sendFramedRequest(port, readFileRequest(POD_UID.slice(0, 8)))

		expect(read.reply).toEqual({ ok: false, error: 'unauthorized' })
		expect(truncated.reply).toEqual({ ok: false, error: 'unauthorized' })
	})

	it('refuses a request that carries no token at all', async () => {
		const read = await sendFramedRequest(port, readFileRequest())

		expect(read.reply).toEqual({ ok: false, error: 'unauthorized' })
		expect(read.closedByAgent).toBe(true)
	})

	it('refuses an unauthorized execute before anything is spawned', async () => {
		const exchange = await sendFramedRequest(port, {
			op: 'execute',
			token: OTHER_UID,
			body: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
		})

		// The streaming shape — NDJSON events then a zero-length terminator
		// — never starts: the gate answers before dispatch reaches a handler.
		expect(exchange.frames).toEqual([JSON.stringify({ ok: false, error: 'unauthorized' })])
	})

	it('serves healthz with no token and echoes none back', async () => {
		const health = await sendFramedRequest(port, { op: 'healthz' })

		expect(health.reply).toEqual({
			ok: true,
			protocolVersion: agent.FIRECRACKER_AGENT_PROTOCOL_VERSION,
			features: agent.AGENT_FEATURES,
		})
		// `features` is the only thing beside the version a probe learns:
		// capabilities the version does not announce, so a host can ask
		// before it relies on one. Still nothing about the credential.
		expect(Object.keys(health.reply)).toEqual(['ok', 'protocolVersion', 'features'])
		expect(health.frames.join('')).not.toContain(POD_UID)
	})

	it('keeps the token out of the environment of an execute child', async () => {
		// The agent's own process has them; the child must not. The marker
		// is what keeps this honest: it proves the child inherits an
		// environment at all, so an empty list means scrubbed and not just
		// unpopulated.
		expect(process.env.NAMZU_AGENT_BIND_TOKEN).toBe(POD_UID)
		expect(process.env.NAMZU_SANDBOX_WORKSPACE).toBe(workDir)
		process.env.NAMZU_TEST_MARKER = 'inherited'

		const exchange = await sendFramedRequest(port, {
			op: 'execute',
			token: POD_UID,
			body: {
				command: process.execPath,
				args: [
					'-e',
					'console.log(JSON.stringify({ scrubbed: Object.keys(process.env).filter((key) => key.startsWith("NAMZU_AGENT_") || key.startsWith("NAMZU_SANDBOX_")), marker: process.env.NAMZU_TEST_MARKER ?? null }))',
				],
			},
		})

		const events = exchange.frames
			.filter((raw) => raw.length > 0)
			.map((raw) => JSON.parse(raw) as Record<string, unknown>)
		const stdout = events
			.filter((event) => event.type === 'stdout_delta')
			.map((event) => String(event.data))
			.join('')
		const result = events.find((event) => event.type === 'result')

		expect(result?.exitCode).toBe(0)
		expect(JSON.parse(stdout)).toEqual({ scrubbed: [], marker: 'inherited' })
	})

	// The other spawning op, and the one that matters most: a terminal is
	// an interactive shell handed to the workload, so it is the shortest
	// path from the workload to the agent's own environment. Linux only —
	// the PTY is util-linux `script` plus /proc, as the Firecracker
	// transport suite's own PTY case is.
	it.skipIf(process.platform !== 'linux')(
		'keeps the token out of the environment of a terminal shell',
		async () => {
			process.env.NAMZU_TEST_MARKER = 'inherited'

			const exchange = await sendFramedRequest(port, {
				op: 'terminal',
				token: POD_UID,
				body: {
					cols: 80,
					rows: 24,
					cwd: workDir,
					command: '/bin/sh',
					// `env` first so the output is forwarded early; the sleep
					// keeps the shell alive while the agent resolves the PTY
					// slave through /proc and answers `ready`.
					args: ['-c', 'env; sleep 1'],
				},
			})

			const events = exchange.frames
				.filter((raw) => raw.length > 0)
				.map((raw) => JSON.parse(raw) as Record<string, unknown>)
			const output = events
				.filter((event) => event.type === 'data')
				.map((event) => String(event.data))
				.join('')

			expect(events.some((event) => event.type === 'ready')).toBe(true)
			// Same honesty as the execute case: the marker proves the shell
			// inherited an environment at all, and TERM proves this is the
			// terminal path's own env and not some stripped-bare default.
			expect(output).toContain('NAMZU_TEST_MARKER=inherited')
			expect(output).toContain('TERM=xterm-256color')
			expect(output).not.toContain(POD_UID)
			expect(output).not.toMatch(/NAMZU_AGENT_|NAMZU_SANDBOX_/)
		},
	)
})

describe('trust-on-first-use fallback', () => {
	beforeEach(async () => {
		process.env.NAMZU_AGENT_REQUIRE_TOKEN = '1'
		await startAgent()
	})

	it('binds the first token it is shown and keeps serving it', async () => {
		await writeSecret(POD_UID)

		const again = await sendFramedRequest(port, readFileRequest(POD_UID))

		expect(again.reply.ok).toBe(true)
	})

	it('refuses every later token, and the refusal does not unseat the binding', async () => {
		await writeSecret(POD_UID)

		const intruder = await sendFramedRequest(port, readFileRequest(OTHER_UID))
		const bound = await sendFramedRequest(port, readFileRequest(POD_UID))

		expect(intruder.reply).toEqual({ ok: false, error: 'unauthorized' })
		expect(intruder.closedByAgent).toBe(true)
		expect(bound.reply.ok).toBe(true)
	})

	it('cannot be bound by a request with no token, or with an empty one', async () => {
		const missing = await sendFramedRequest(port, readFileRequest())
		const empty = await sendFramedRequest(port, readFileRequest(''))

		expect(missing.reply).toEqual({ ok: false, error: 'unauthorized' })
		expect(empty.reply).toEqual({ ok: false, error: 'unauthorized' })
		// Had either bound the agent, this token would now be the intruder.
		await writeSecret(POD_UID)
	})

	it('serves healthz before and after a binding exists', async () => {
		const before = await sendFramedRequest(port, { op: 'healthz' })
		await writeSecret(POD_UID)
		const after = await sendFramedRequest(port, { op: 'healthz' })

		expect(before.reply.ok).toBe(true)
		expect(after.reply).toEqual({
			ok: true,
			protocolVersion: agent.FIRECRACKER_AGENT_PROTOCOL_VERSION,
			features: agent.AGENT_FEATURES,
		})
	})
})

describe('neither variable set (the Firecracker vsock and unix path)', () => {
	beforeEach(async () => {
		await startAgent()
	})

	it('serves a request that carries no token, exactly as before the gate', async () => {
		await writeSecret()

		const read = await sendFramedRequest(port, readFileRequest())

		expect(read.reply.ok).toBe(true)
		expect(Buffer.from(String(read.reply.content), 'base64').toString('utf8')).toBe(
			'workspace content',
		)
	})

	it('ignores a token nobody asked for rather than binding to it', async () => {
		await writeSecret(POD_UID)

		const other = await sendFramedRequest(port, readFileRequest(OTHER_UID))
		const none = await sendFramedRequest(port, readFileRequest())

		expect(other.reply.ok).toBe(true)
		expect(none.reply.ok).toBe(true)
	})

	it('serves healthz at the unchanged protocol version', async () => {
		const health = await sendFramedRequest(port, { op: 'healthz' })

		expect(health.reply).toEqual({
			ok: true,
			protocolVersion: 2,
			features: agent.AGENT_FEATURES,
		})
	})
})

/**
 * What an unauthenticated peer can spend before the gate can even run.
 *
 * The credential rides inside the envelope, so the gate cannot decide
 * anything until a whole frame has been parsed — which is exactly the
 * window these cases bound. Each case closes a different hole: a refusal
 * that takes the connection down rather than half-closing it; a cap on
 * the length a frame header may announce before anyone has
 * authenticated; a fixed-width header, so bytes that announce nothing at
 * all are refused on the ninth of them rather than buffered forever; an
 * idle timeout on a connection that never authenticates; an ABSOLUTE
 * deadline from accept that no byte resets, for the connection that is
 * not idle but is going nowhere; and two bounds on unauthenticated
 * connections as a set — how many of them there may be and what they may
 * buffer between them — without which every bound above could simply be
 * paid again on the next connection.
 *
 * The last two cases here are the slow loris, which the idle timeout and
 * the connection count could not answer between them and in one shape
 * made each other worse: bytes reset the idle timer, so a peer dripping
 * one every few seconds held its slot forever, and a pool that refused
 * the NEWEST connection then let a poolful of such peers decide that
 * nobody else — not even the credential-exempt `healthz` probe — got
 * served. The deadline bounds the squatter and the eviction takes its
 * slot back for the newcomer.
 */
describe('bounds on an unauthenticated connection', () => {
	beforeEach(async () => {
		process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
		await startAgent()
	})

	it('destroys a refused connection instead of leaving it readable', async () => {
		const client = await dial()
		client.write(encodeFrame(JSON.stringify(readFileRequest(OTHER_UID))))

		expect(await firstFrame(client)).toEqual({ ok: false, error: 'unauthorized' })

		// A refusal used to `end()` the socket, which closes only the
		// writable half: this flood kept being read into the agent's frame
		// buffer, for as long as the refused peer cared to send it.
		const connection = accepted.at(-1) as AcceptedConnection
		flood(client, 4)
		await expectAgentClosed(connection)

		expect(connection.socket.destroyed).toBe(true)
		expect(await liveConnections()).toBe(0)
		// The whole point, as bytes: the agent read the one request frame
		// and then stopped, rather than taking the 4 MiB behind it.
		expect(connection.socket.bytesRead).toBeLessThan(1024 * 1024)

		// Deterministic rather than a memory bound: a destroyed socket can
		// read nothing, so this cannot move however much more is written.
		const readAtClose = connection.socket.bytesRead
		flood(client, 4)
		await delay(50)
		expect(connection.socket.bytesRead).toBe(readAtClose)
	})

	it('refuses a frame header that announces more than a pre-auth frame may', async () => {
		const client = await dial()
		// 0xffffff00 is ~4 GiB: what the 8-hex prefix permits, what the
		// reader used to honour, and what an unauthenticated peer could
		// therefore stream toward one chunk at a time.
		client.write(Buffer.from('ffffff00\n', 'ascii'))
		client.write(Buffer.alloc(256 * 1024, 0x61))

		const reply = await firstFrame(client)

		expect(reply.ok).toBe(false)
		expect(String(reply.error)).toBe(
			`frame_too_large: announced 4294967040 bytes, limit ${8 * 1024 * 1024} (NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES)`,
		)
		const connection = accepted.at(-1) as AcceptedConnection
		await expectAgentClosed(connection)
		expect(connection.socket.destroyed).toBe(true)
	})

	// The announced-length cap cannot catch a peer that announces nothing:
	// with no newline in the stream there is no length prefix to check, and
	// the idle timeout does not catch it either, because a peer that keeps
	// writing is never idle. A header is nine bytes or it is not a header,
	// which is what makes the ninth byte the place to decide.
	it('refuses a stream that never carries a frame header at all', async () => {
		const client = await dial()
		flood(client, 4)

		const connection = accepted.at(-1) as AcceptedConnection
		await expectAgentClosed(connection)

		expect(connection.socket.destroyed).toBe(true)
		expect(await liveConnections()).toBe(0)
		// Not "some bound was applied" but "the agent stopped at the first
		// chunk": 4 MiB was written at it and it read a fraction of one.
		expect(connection.socket.bytesRead).toBeLessThan(1024 * 1024)
	})

	// The consequence of putting the credential in the envelope rather than
	// in a handshake: a `write-file` body travels in the same first frame as
	// the token, so the pre-auth cap IS the write-file ceiling here. The
	// default has to clear a file a caller would really send — this is the
	// case that says how much.
	it('admits a write-file body of a size a caller would actually send', async () => {
		const body = Buffer.alloc(512 * 1024, 0x61)

		const written = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: join(workDir, 'big.bin'),
				content: body.toString('base64'),
				encoding: 'base64',
			},
		})

		expect(written.reply).toEqual({ ok: true, bytesWritten: body.length })
	})

	// And the ceiling itself, pinned with the cap turned down so the case
	// costs nothing to run and still says what it means: a body above it is
	// refused, and the refusal names the variable to raise.
	it('caps a write-file body at the pre-auth ceiling, and names the variable', async () => {
		process.env.NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES = String(64 * 1024)
		await startAgent()
		const request = {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: join(workDir, 'big.bin'),
				content: Buffer.alloc(128 * 1024, 0x61).toString('base64'),
				encoding: 'base64',
			},
		}

		const oversized = await sendFramedRequest(port, request)

		expect(String(oversized.reply.error)).toBe(
			`frame_too_large: announced ${Buffer.byteLength(JSON.stringify(request), 'utf8')} bytes, limit ${64 * 1024} (NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES)`,
		)
		expect(oversized.closedByAgent).toBe(true)
	})

	it('destroys a connection that opens and never authenticates', async () => {
		// The caps above bound a peer that sends; this bounds one that does
		// not. Both are needed: neither catches the other's case.
		process.env.NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS = '150'
		await startAgent()
		await dial()

		const connection = accepted.at(-1) as AcceptedConnection
		await expectAgentClosed(connection)

		expect(connection.socket.destroyed).toBe(true)
		expect(await liveConnections()).toBe(0)
	})

	// Every bound above is per connection, so on its own each of them can
	// be paid many times over by opening many connections. This is the one
	// that stops the multiplication — and it stops it by giving up its
	// OLDEST member, never by turning the arrival away.
	it('bounds how many connections may be unauthenticated at once', async () => {
		process.env.NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS = '1'
		await startAgent()
		await writeSecret(POD_UID)

		// One slot, and a connection sitting in it without authenticating.
		const held = await dial()
		const heldConnection = accepted.at(-1) as AcceptedConnection
		// Armed before the arrival that evicts it, so the refusal cannot be
		// missed between the eviction and the read.
		const eviction = firstFrame(held)

		const next = await dial()
		const nextConnection = accepted.at(-1) as AcceptedConnection
		next.write(encodeFrame(JSON.stringify(readFileRequest(POD_UID))))

		// The arrival is served, and the squatter is the one that pays —
		// told which bound it lost to, then destroyed.
		expect((await firstFrame(next)).ok).toBe(true)
		expect(await eviction).toEqual({
			ok: false,
			error: 'too_many_unauthenticated_connections: limit 1 (NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS)',
		})
		await expectAgentClosed(heldConnection)

		// The budget counts connections that have NOT authenticated, not
		// connections: `next` presented its token, so it holds no slot and
		// the dial after it evicts nobody.
		const after = await dial()
		after.write(encodeFrame(JSON.stringify(readFileRequest(POD_UID))))

		expect((await firstFrame(after)).ok).toBe(true)
		expect(nextConnection.socket.destroyed).toBe(false)
	})

	// The idle timeout above retires a connection that says nothing. This
	// is the one that says just enough, forever: the reviewer's slow loris,
	// one byte every few seconds, which resets that timer on every byte and
	// so used to hold its slot until the process died.
	it('destroys connections that trickle bytes past the pre-auth deadline', async () => {
		process.env.NAMZU_AGENT_PREAUTH_DEADLINE_MS = '250'
		// Far above the deadline, so nothing observed here can be the idle
		// timer's doing — and the drip would keep resetting it anyway.
		process.env.NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS = '60000'
		await startAgent()

		// Dialled one at a time so each connection is on the agent's side of
		// the listener before the next starts; concurrently they would all
		// be waiting on the same accept.
		const loris: Socket[] = []
		for (let opened = 0; opened < 8; opened += 1) loris.push(await trickle())
		const connections = accepted.slice(-loris.length)
		await Promise.all(connections.map(expectAgentClosed))

		// Destroyed while still writing: the drip never stopped, and the
		// deadline did not care.
		expect(connections.map((connection) => connection.socket.destroyed)).toEqual(
			loris.map(() => true),
		)
		expect(await liveConnections()).toBe(0)
	})

	// And the other half of the same attack. A full pool used to refuse the
	// arrival, which handed the squatters the power to decide who else was
	// served; `healthz` needs no credential precisely so a readiness probe
	// always gets an answer, and it was getting a refusal instead.
	it('evicts its oldest squatter so a newcomer is still served', async () => {
		process.env.NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS = '2'
		// Both timers far out: this case is about the eviction alone.
		process.env.NAMZU_AGENT_PREAUTH_DEADLINE_MS = '60000'
		process.env.NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS = '60000'
		await startAgent()
		const oldest = await trickle()
		const oldestConnection = accepted.at(-1) as AcceptedConnection
		// Accepted strictly later, so "oldest" is not a coin toss.
		await delay(20)
		await trickle()
		const youngerConnection = accepted.at(-1) as AcceptedConnection
		const eviction = firstFrame(oldest)

		const health = await sendFramedRequest(port, { op: 'healthz' })

		expect(health.reply).toEqual({
			ok: true,
			protocolVersion: agent.FIRECRACKER_AGENT_PROTOCOL_VERSION,
			features: agent.AGENT_FEATURES,
		})
		expect(await eviction).toEqual({
			ok: false,
			error: 'too_many_unauthenticated_connections: limit 2 (NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS)',
		})
		await expectAgentClosed(oldestConnection)
		// Only the oldest paid. Eviction takes one slot, not the pool.
		expect(youngerConnection.socket.destroyed).toBe(false)
	})

	// The deadline bounds the window before the gate runs and nothing
	// after it. A streaming `execute` outlives it by design, and so do the
	// `terminal` and `tcp-connect` sessions that stay open for minutes.
	it('never measures an authenticated connection against the pre-auth deadline', async () => {
		process.env.NAMZU_AGENT_PREAUTH_DEADLINE_MS = '200'
		process.env.NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS = '200'
		await startAgent()

		const exchange = await sendFramedRequest(port, {
			op: 'execute',
			token: POD_UID,
			body: {
				// Silent for well past both timers, then speaks: a connection
				// that is authenticated, idle and long-lived all at once.
				command: process.execPath,
				args: ['-e', 'setTimeout(() => console.log("outlived"), 900)'],
			},
		})

		const events = exchange.frames
			.filter((raw) => raw.length > 0)
			.map((raw) => JSON.parse(raw) as Record<string, unknown>)
		const stdout = events
			.filter((event) => event.type === 'stdout_delta')
			.map((event) => String(event.data))
			.join('')

		expect(events.find((event) => event.type === 'result')?.exitCode).toBe(0)
		expect(stdout).toContain('outlived')
	})

	// The count above bounds sockets; this bounds the heap behind them,
	// which is what actually runs out. Each connection here stays inside
	// its own per-connection cap — what they exceed is the budget they
	// share.
	it('bounds what all unauthenticated connections buffer between them', async () => {
		process.env.NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES = String(64 * 1024)
		process.env.NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES = String(64 * 1024)
		await startAgent()

		// A frame of exactly the per-connection cap, announced and then most
		// of it sent: allowed, and held while the rest is waited for.
		const holding = await dial()
		holding.write(Buffer.from('00010000\n', 'ascii'))
		holding.write(Buffer.alloc(60 * 1024, 0x61))
		await delay(100)
		const second = await dial()
		second.write(Buffer.from('00010000\n', 'ascii'))
		second.write(Buffer.alloc(60 * 1024, 0x61))

		expect(await firstFrame(second)).toEqual({
			ok: false,
			error: `preauth_buffer_exhausted: limit ${64 * 1024} bytes (NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES)`,
		})
		await expectAgentClosed(accepted.at(-1) as AcceptedConnection)
		expect((accepted.at(-1) as AcceptedConnection).socket.destroyed).toBe(true)
	})
})

describe('bounds with neither variable set (the Firecracker vsock and unix path)', () => {
	beforeEach(async () => {
		await startAgent()
	})

	// The pre-auth cap is a TOKEN-mode bound. On the Firecracker path there
	// is no gate to be pre-authenticated for, and a `write-file` frame of
	// any size is exactly what that path has always sent.
	it('accepts a frame far above the pre-auth cap when no token is required', async () => {
		// Turned down so the case keeps saying what it means whatever the
		// default is: what matters here is that no pre-auth cap is armed at
		// all, not that this particular body fits under one.
		process.env.NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES = String(64 * 1024)
		await startAgent()
		const body = Buffer.alloc(128 * 1024, 0x61)

		const written = await sendFramedRequest(port, {
			op: 'write-file',
			body: {
				path: join(workDir, 'big.bin'),
				content: body.toString('base64'),
				encoding: 'base64',
			},
		})

		expect(written.reply).toEqual({ ok: true, bytesWritten: body.length })
	})

	// The global ceiling is not a token-mode bound: the 8-hex prefix lets
	// ANY peer name 4 GiB, and the reader used to believe it.
	it('still refuses a header that announces more than any frame may be', async () => {
		const client = await dial()
		client.write(Buffer.from('ffffff00\n', 'ascii'))
		client.write(Buffer.alloc(256 * 1024, 0x61))

		const reply = await firstFrame(client)

		expect(String(reply.error)).toBe(
			`frame_too_large: announced 4294967040 bytes, limit ${256 * 1024 * 1024} (NAMZU_AGENT_MAX_FRAME_BYTES)`,
		)
		const connection = accepted.at(-1) as AcceptedConnection
		await expectAgentClosed(connection)
		expect(connection.socket.destroyed).toBe(true)
	})

	// Neither the deadline nor the eviction exists on this path either:
	// there is no pre-auth pool to be in, because there is nothing here to
	// be unauthenticated for. Both knobs are turned down to values that
	// would be unmistakable if they were armed.
	it('leaves trickling and crowded connections alone when no token is required', async () => {
		process.env.NAMZU_AGENT_PREAUTH_DEADLINE_MS = '150'
		process.env.NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS = '1'
		await startAgent()
		const first = await trickle()
		await delay(20)
		await trickle()

		await delay(600)

		const connections = accepted.slice(-2)
		expect(connections.map((connection) => connection.socket.destroyed)).toEqual([false, false])
		expect(first.destroyed).toBe(false)
		expect(await liveConnections()).toBe(2)
	})

	// No idle timer is armed on this path, so nothing here can age out a
	// terminal or a tcp-connect session that is simply quiet.
	it('leaves a quiet connection open rather than ageing it out', async () => {
		process.env.NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS = '150'
		await startAgent()
		await dial()
		const connection = accepted.at(-1) as AcceptedConnection

		await delay(600)

		expect(connection.socket.destroyed).toBe(false)
		expect(await liveConnections()).toBe(1)
	})
})
