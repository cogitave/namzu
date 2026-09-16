/**
 * Telling a quiet stream from a dead one, against the REAL guest agent
 * (`agent/agent.cjs`) over a real loopback TCP connection.
 *
 * Once a `terminal` or `tcp-connect` stream reports `ready` the transport
 * clears its read-idle timer, and it is right to: an interactive shell may
 * sit silent for hours. Nothing took the timer's place, so a peer that went
 * away without a FIN or an RST — a lost node, a partition, a middlebox that
 * drops idle state — left the host's `exited`/`closed` unresolved forever and
 * the shell's process group alive in the guest until the pod stopped.
 *
 * **The partition is a proxy, not a policy.** Every case that needs one puts
 * a loopback TCP proxy between the transport and the agent and then stops it
 * forwarding in both directions while keeping both sockets open — which is
 * exactly what a black-holed connection looks like to either end, and is
 * strictly better evidence than a cluster run: the kind test bed's CNI does
 * not enforce NetworkPolicy, so a "the packets stopped" probe there would
 * pass for the wrong reason.
 *
 * Both halves of the negotiation are covered in both directions, because the
 * whole compatibility argument rests on them: a host that asks against an
 * agent that predates the field must behave exactly as it did, and an agent
 * that implements it must write nothing at all to a host that did not ask.
 */

import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import net, { type AddressInfo, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	MIN_STREAM_HEARTBEAT_MS,
	STREAM_HEARTBEAT_FEATURE,
	STREAM_HEARTBEAT_MAX_ECHO_FACTOR,
	STREAM_HEARTBEAT_MISS_LIMIT,
} from '../../firecracker/protocol.js'
import { __framing } from '../../firecracker/transport.js'
import { DEFAULT_STREAM_HEARTBEAT_MS, resolveStreamHeartbeatMs } from '../index.js'
import { KubernetesAgentTransport } from '../transport.js'
import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import { decodeFrames, encodeFrame, sendFramedRequest } from './fixtures/framed-agent-client.js'

const IS_WINDOWS = process.platform === 'win32'
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'

/**
 * Short enough that a case finishes in a second or two, long enough that
 * neither a GC pause nor a slow CI box reads as three missed intervals.
 */
const INTERVAL_MS = 150
/** Three misses plus one watchdog tick, plus slack for a loaded machine. */
const DEATH_BUDGET_MS = INTERVAL_MS * STREAM_HEARTBEAT_MISS_LIMIT + 1_500
/** The same, for a stream whose guest echoed more than the host will honour. */
const CLAMPED_DEATH_BUDGET_MS =
	INTERVAL_MS * STREAM_HEARTBEAT_MAX_ECHO_FACTOR * STREAM_HEARTBEAT_MISS_LIMIT + 1_500
/** Big enough that the frame carrying it is worth dribbling across the wire. */
const BIG_PAYLOAD = Buffer.alloc(512 * 1024, 0x7a)
/** Pieces, one interval apart: the last lands well past the death window. */
const DRIBBLE_PIECES = 8

interface AgentModule {
	startListening(): Promise<Server>
}

/** A pod uid is what the downward API actually delivers; shaped like one. */
const POD_UID = '6f0b5d2e-2f3a-4b8c-9d1e-77aa0c4f1b32'

let workDir: string
let listener: Server | undefined
let saved: Record<string, string | undefined>
const closers: (() => Promise<void>)[] = []

function clearEnv(keys: readonly string[]): void {
	for (const key of keys) delete process.env[key]
}

/** Load a FRESH agent module, so module-level listen state never leaks. */
function loadAgent(): AgentModule {
	delete require_.cache[require_.resolve(AGENT_PATH)]
	return require_(AGENT_PATH) as AgentModule
}

async function startAgent(): Promise<number> {
	process.env.NAMZU_AGENT_TCP_PORT = '0'
	process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
	const agent = loadAgent()
	listener = await agent.startListening()
	return (listener.address() as AddressInfo).port
}

function transportTo(port: number, heartbeatMs?: number): KubernetesAgentTransport {
	return new KubernetesAgentTransport(
		{ kind: 'tcp', host: '127.0.0.1', port, token: POD_UID },
		heartbeatMs === undefined ? {} : { heartbeatMs },
	)
}

interface PartitionProxy {
	readonly port: number
	/**
	 * Stop forwarding in BOTH directions while leaving every socket open.
	 * Nothing is closed, reset or refused — both ends keep a socket that
	 * looks perfectly healthy and over which nothing will ever arrive again.
	 */
	blackhole(): void
}

async function startPartitionProxy(targetPort: number): Promise<PartitionProxy> {
	const pairs: { client: Socket; upstream: Socket }[] = []
	let partitioned = false
	const server = net.createServer((client) => {
		const upstream = net.connect({ host: '127.0.0.1', port: targetPort })
		pairs.push({ client, upstream })
		const stop = () => {
			client.destroy()
			upstream.destroy()
		}
		client.on('error', stop)
		upstream.on('error', stop)
		client.on('data', (chunk) => {
			if (!partitioned) upstream.write(chunk)
		})
		upstream.on('data', (chunk) => {
			if (!partitioned) client.write(chunk)
		})
		client.on('close', () => upstream.destroy())
		upstream.on('close', () => client.destroy())
		if (partitioned) {
			client.pause()
			upstream.pause()
		}
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	closers.push(
		async () =>
			await new Promise<void>((resolve) => {
				for (const pair of pairs) {
					pair.client.destroy()
					pair.upstream.destroy()
				}
				server.close(() => resolve())
			}),
	)
	return {
		port: (server.address() as AddressInfo).port,
		blackhole() {
			partitioned = true
			// Paused as well as dropped, so the kernel stops draining either
			// side's send buffer: a peer that keeps writing fills its window
			// rather than having its bytes quietly consumed by the proxy.
			for (const pair of pairs) {
				pair.client.pause()
				pair.upstream.pause()
			}
		},
	}
}

interface LegacyAgent {
	readonly port: number
	/** Every frame the host wrote, in order, parsed. */
	readonly received: Record<string, unknown>[]
}

/**
 * An agent built before this change: it serves `terminal` and `tcp-connect`,
 * answers a bare `ready` with no `heartbeatMs` — because it has never heard
 * of the field — and then says nothing at all for as long as the stream is
 * open. A host talking to it must behave exactly as it did before there was
 * a heartbeat to negotiate.
 */
async function startLegacyAgent(): Promise<LegacyAgent> {
	const received: Record<string, unknown>[] = []
	const sockets = new Set<Socket>()
	const server = net.createServer((socket) => {
		sockets.add(socket)
		const reader = new __framing.FrameReader()
		socket.on('error', () => {})
		socket.on('close', () => sockets.delete(socket))
		socket.on('data', (chunk: Buffer) => {
			for (const payload of reader.push(chunk)) {
				if (payload.length === 0) continue
				const message = JSON.parse(payload) as Record<string, unknown>
				received.push(message)
				if (message.op === 'terminal' || message.op === 'tcp-connect') {
					socket.write(__framing.frame(JSON.stringify({ type: 'ready' })))
				}
			}
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	closers.push(
		async () =>
			await new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				server.close(() => resolve())
			}),
	)
	return { port: (server.address() as AddressInfo).port, received }
}

interface EchoingAgent {
	readonly port: number
	/** Write one frame to the open stream in `pieces`, `gapMs` apart. */
	dribble(frame: Buffer, pieces: number, gapMs: number): Promise<void>
}

/**
 * An agent that implements the heartbeat but answers with an interval of the
 * case's choosing, and writes only what the case tells it to.
 *
 * Two things need it. The echo is a number from the POD and the host times
 * its own watchdog with it, so a case has to be able to send a dishonest
 * one. And one frame has to be able to arrive in pieces spanning more than
 * the death window, which the real agent — writing whole frames at once over
 * loopback — will never do by itself.
 */
async function startEchoingAgent(options: {
	readonly echoHeartbeatMs: number
	readonly beatEveryMs?: number
}): Promise<EchoingAgent> {
	const sockets = new Set<Socket>()
	const streams = new Set<Socket>()
	const timers: ReturnType<typeof setInterval>[] = []
	const server = net.createServer((socket) => {
		sockets.add(socket)
		const reader = new __framing.FrameReader()
		socket.on('error', () => {})
		socket.on('close', () => {
			sockets.delete(socket)
			streams.delete(socket)
		})
		socket.on('data', (chunk: Buffer) => {
			for (const payload of reader.push(chunk)) {
				if (payload.length === 0) continue
				const message = JSON.parse(payload) as Record<string, unknown>
				if (message.op !== 'terminal' && message.op !== 'tcp-connect') continue
				streams.add(socket)
				socket.write(
					__framing.frame(JSON.stringify({ type: 'ready', heartbeatMs: options.echoHeartbeatMs })),
				)
				if (options.beatEveryMs === undefined) continue
				const beat = setInterval(() => {
					if (socket.destroyed) return
					socket.write(__framing.frame(JSON.stringify({ type: 'heartbeat' })))
				}, options.beatEveryMs)
				beat.unref?.()
				timers.push(beat)
			}
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	closers.push(
		async () =>
			await new Promise<void>((resolve) => {
				for (const timer of timers) clearInterval(timer)
				for (const socket of sockets) socket.destroy()
				server.close(() => resolve())
			}),
	)
	return {
		port: (server.address() as AddressInfo).port,
		async dribble(frame, pieces, gapMs) {
			const size = Math.ceil(frame.byteLength / pieces)
			for (let offset = 0; offset < frame.byteLength; offset += size) {
				for (const socket of streams) socket.write(frame.subarray(offset, offset + size))
				await delay(gapMs)
			}
		},
	}
}

interface RawStream {
	/** The agent's `ready` event, parsed. */
	readonly ready: Record<string, unknown>
	/** Write one frame to the agent in `pieces`, `gapMs` apart. */
	dribble(frame: Buffer, pieces: number, gapMs: number): Promise<void>
	close(): void
}

/**
 * A raw framed client that asks the REAL agent for a heartbeat, waits for its
 * echo, and can then write one frame in pieces. It sends no heartbeat of its
 * own, so those pieces are the only thing the guest's watchdog can see.
 */
async function openRawTcpStream(
	agentPort: number,
	upstreamPort: number,
	heartbeatMs: number,
): Promise<RawStream> {
	const socket = net.connect({ host: '127.0.0.1', port: agentPort })
	let rest: Buffer = Buffer.alloc(0)
	let ready: Record<string, unknown> | undefined
	socket.on('error', () => {})
	socket.on('data', (chunk) => {
		const decoded = decodeFrames(rest.length === 0 ? chunk : Buffer.concat([rest, chunk]))
		for (const payload of decoded.frames) {
			if (payload.length === 0) continue
			const event = JSON.parse(payload) as Record<string, unknown>
			if (event.type === 'ready') ready = event
		}
		rest = decoded.rest
	})
	closers.push(async () => {
		socket.destroy()
	})
	await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
	socket.write(
		encodeFrame(
			JSON.stringify({
				op: 'tcp-connect',
				body: { host: '127.0.0.1', port: upstreamPort, heartbeatMs },
				token: POD_UID,
			}),
		),
	)
	await vi.waitFor(() => expect(ready).toBeDefined(), { timeout: 5_000 })
	if (ready === undefined) throw new Error('the agent never answered ready')
	return {
		ready,
		async dribble(frame, pieces, gapMs) {
			const size = Math.ceil(frame.byteLength / pieces)
			for (let offset = 0; offset < frame.byteLength; offset += size) {
				socket.write(frame.subarray(offset, offset + size))
				await delay(gapMs)
			}
		},
		close() {
			socket.destroy()
		},
	}
}

interface Upstream {
	readonly port: number
	/** Live connections the guest currently holds to this service. */
	live(): number
	/** Bytes read so far. Frozen for as long as the service is paused. */
	read(): number
	/** Start reading again, releasing the guest's write backpressure. */
	drain(): void
}

/**
 * A loopback service the guest forwards to.
 *
 * With `read: false` it accepts and then stops reading, which is the only
 * way to make the guest pause ITS host socket from outside the guest: the
 * guest's `upstream.write` returns false and the handler pauses the host
 * connection until the drain.
 */
async function startUpstream(options: { readonly read?: boolean } = {}): Promise<Upstream> {
	const sockets = new Set<Socket>()
	let bytes = 0
	let paused = options.read === false
	const server = net.createServer((socket) => {
		sockets.add(socket)
		socket.on('error', () => {})
		socket.on('close', () => sockets.delete(socket))
		socket.on('data', (chunk: Buffer) => {
			bytes += chunk.byteLength
		})
		if (paused) socket.pause()
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	closers.push(
		async () =>
			await new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				server.close(() => resolve())
			}),
	)
	return {
		port: (server.address() as AddressInfo).port,
		live: () => sockets.size,
		read: () => bytes,
		drain: () => {
			paused = false
			for (const socket of sockets) socket.resume()
		},
	}
}

/** Resolves to `'settled'` if the promise settles inside `ms`, else `'open'`. */
async function raceSettled(promise: Promise<unknown>, ms: number): Promise<'settled' | 'open'> {
	return await Promise.race([
		promise.then(
			() => 'settled' as const,
			() => 'settled' as const,
		),
		delay(ms, 'open' as const),
	])
}

beforeEach(() => {
	saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	clearEnv(AGENT_ENV_KEYS)
	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-stream-liveness-')))
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
})

afterEach(async () => {
	for (const close of closers.splice(0)) await close()
	if (listener) {
		await new Promise<void>((resolve) => listener?.close(() => resolve()))
		listener = undefined
	}
	clearEnv(AGENT_ENV_KEYS)
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	rmSync(workDir, { recursive: true, force: true })
})

describe.skipIf(IS_WINDOWS)('a negotiated heartbeat leaves a healthy quiet stream alone', () => {
	it('advertises the capability in healthz, without moving the protocol version', async () => {
		const port = await startAgent()
		const { reply } = await sendFramedRequest(port, { op: 'healthz' })
		expect(reply.features).toContain(STREAM_HEARTBEAT_FEATURE)
		// Pinned: an additive, optional field on two existing ops is not a
		// wire change, so no host and no image has to roll with it.
		expect(reply.protocolVersion).toBe(2)
	})

	it.skipIf(process.platform !== 'linux')(
		'keeps a terminal running sleep 3600 open for ten intervals',
		async () => {
			const port = await startAgent()
			const terminal = await transportTo(port, INTERVAL_MS).openTerminal({
				command: '/bin/sh',
				args: ['-c', 'sleep 3600'],
				cwd: workDir,
				size: { cols: 80, rows: 24 },
			})
			expect(await raceSettled(terminal.exited, INTERVAL_MS * 10)).toBe('open')
			terminal.kill('SIGKILL')
			await terminal.exited
		},
		20_000,
	)

	it('keeps an idle TCP connection open for ten intervals', async () => {
		const port = await startAgent()
		const upstream = await startUpstream()
		const connection = await transportTo(port, INTERVAL_MS).openTcpConnection({
			port: upstream.port,
		})
		expect(await raceSettled(connection.closed, INTERVAL_MS * 10)).toBe('open')
		expect(upstream.live()).toBe(1)
		connection.destroy()
	}, 20_000)
})

// Separately for a TERMINAL and for a TCP CONNECTION, because they are two
// handlers on each side with two different cleanups, and a fix that only
// reaches one of them would pass a single combined case.
describe.skipIf(IS_WINDOWS)('a partitioned stream ends on both sides', () => {
	it.skipIf(process.platform !== 'linux')(
		'resolves a terminal exited, and the guest kills its process group',
		async () => {
			const agentPort = await startAgent()
			const proxy = await startPartitionProxy(agentPort)
			const ticks = join(workDir, 'ticks')
			const terminal = await transportTo(proxy.port, INTERVAL_MS).openTerminal({
				// Ticks into a FILE, not stdout: a shell that stopped because
				// its output backpressured would look exactly like one that was
				// killed, and the file is the only witness that is not the
				// connection under test.
				command: '/bin/sh',
				args: ['-c', `while :; do echo tick >> ${ticks}; sleep 0.1; done`],
				cwd: workDir,
				size: { cols: 80, rows: 24 },
			})
			await vi.waitFor(() => expect(statSync(ticks).size).toBeGreaterThan(0))

			proxy.blackhole()
			const exit = await Promise.race([terminal.exited, delay(DEATH_BUDGET_MS, undefined)])
			// What a closed socket already produces, so a caller that already
			// handles a severed stream needs no new branch.
			expect(exit).toEqual({ exitCode: -1 })

			// And the guest's own watchdog ran the same cleanup a closed socket
			// runs: nothing from that terminal's group is still ticking.
			await vi.waitFor(
				async () => {
					const before = statSync(ticks).size
					await delay(400)
					expect(statSync(ticks).size).toBe(before)
				},
				{ timeout: 10_000, interval: 200 },
			)
		},
		30_000,
	)

	it('resolves a TCP connection closed, and the guest drops its loopback connection', async () => {
		const agentPort = await startAgent()
		const proxy = await startPartitionProxy(agentPort)
		const upstream = await startUpstream()
		const connection = await transportTo(proxy.port, INTERVAL_MS).openTcpConnection({
			port: upstream.port,
		})
		expect(upstream.live()).toBe(1)

		proxy.blackhole()
		expect(await raceSettled(connection.closed, DEATH_BUDGET_MS)).toBe('settled')
		await vi.waitFor(() => expect(upstream.live()).toBe(0), { timeout: 10_000 })
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('backpressure is not silence', () => {
	it('does not end a stream the HOST paused for five intervals', async () => {
		const port = await startAgent()
		const upstream = await startUpstream()
		const connection = await transportTo(port, INTERVAL_MS).openTcpConnection({
			port: upstream.port,
		})
		connection.pause()
		expect(await raceSettled(connection.closed, INTERVAL_MS * 5)).toBe('open')
		connection.resume()
		expect(await raceSettled(connection.closed, INTERVAL_MS * 2)).toBe('open')
		connection.destroy()
	}, 30_000)

	it('does not end a stream the GUEST paused because its upstream stopped reading', async () => {
		const port = await startAgent()
		// A service that accepts and never reads: the guest's write to it
		// returns false, which is what makes the guest pause the host socket.
		const upstream = await startUpstream({ read: false })
		const connection = await transportTo(port, INTERVAL_MS).openTcpConnection({
			port: upstream.port,
		})
		const megabyte = Buffer.alloc(1024 * 1024, 0x61)
		const total = 16 * megabyte.byteLength
		for (let i = 0; i < 16; i += 1) connection.write(megabyte)

		expect(await raceSettled(connection.closed, INTERVAL_MS * 5)).toBe('open')
		// The service has not been reading, so the guest is holding back what
		// it could not hand on — which is the state the watchdog must not
		// mistake for a host that went away.
		expect(upstream.read()).toBeLessThan(total)
		upstream.drain()
		await vi.waitFor(() => expect(upstream.read()).toBe(total), { timeout: 20_000 })
		expect(await raceSettled(connection.closed, INTERVAL_MS * 3)).toBe('open')
		connection.destroy()
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('mixed versions end no stream and write no unknown frame', () => {
	it('arms nothing when the agent does not echo the interval', async () => {
		const legacy = await startLegacyAgent()
		const connection = await transportTo(legacy.port, INTERVAL_MS).openTcpConnection({ port: 9 })
		// The ask went out — it is optional and additive, and an agent that
		// never heard of it drops it.
		expect(legacy.received[0]).toMatchObject({
			op: 'tcp-connect',
			body: { host: '127.0.0.1', port: 9, heartbeatMs: INTERVAL_MS },
		})
		expect(await raceSettled(connection.closed, DEATH_BUDGET_MS)).toBe('open')
		// And nothing this agent would have treated as a protocol error was
		// ever written to it.
		expect(legacy.received.filter((frame) => frame.type === 'heartbeat')).toEqual([])
		connection.destroy()
	}, 30_000)

	it('sends the guest nothing extra when the host never asked', async () => {
		const port = await startAgent()
		const upstream = await startUpstream()
		const frames = await collectTerminalFrames(port, upstream.port, INTERVAL_MS * 6)
		expect(frames[0]).toMatchObject({ type: 'ready' })
		expect(frames[0]).not.toHaveProperty('heartbeatMs')
		expect(frames.filter((frame) => frame.type === 'heartbeat')).toEqual([])
	}, 30_000)

	it('puts no heartbeatMs in the open request when the transport was built without one', async () => {
		const legacy = await startLegacyAgent()
		// The Firecracker-shaped construction: no options at all. Its streams
		// must be byte-identical to what they were.
		const connection = await transportTo(legacy.port).openTcpConnection({ port: 9 })
		expect(legacy.received[0]).toEqual({
			op: 'tcp-connect',
			body: { host: '127.0.0.1', port: 9 },
			token: POD_UID,
		})
		connection.destroy()
	}, 20_000)
})

describe.skipIf(IS_WINDOWS)('the host does not take the guest at its word', () => {
	it('ends a stream whose guest echoed an interval a day long', async () => {
		const agent = await startEchoingAgent({ echoHeartbeatMs: 86_400_000 })
		const connection = await transportTo(agent.port, INTERVAL_MS).openTcpConnection({ port: 9 })
		// Honoured at four times what was ASKED rather than at what came back:
		// a day would have left this stream with no detection at all, which is
		// the failure the heartbeat exists to remove.
		expect(await raceSettled(connection.closed, CLAMPED_DEATH_BUDGET_MS)).toBe('settled')
	}, 30_000)

	it('keeps a stream whose guest echoed a fraction of a millisecond', async () => {
		const agent = await startEchoingAgent({ echoHeartbeatMs: 0.0001, beatEveryMs: INTERVAL_MS })
		const connection = await transportTo(agent.port, INTERVAL_MS).openTcpConnection({ port: 9 })
		// Floored at MIN_STREAM_HEARTBEAT_MS, so the window is 300 ms and a
		// guest beating every 150 ms is plainly alive. Unclamped the window
		// would have been 0.0003 ms and the first tick would have killed it.
		expect(MIN_STREAM_HEARTBEAT_MS * STREAM_HEARTBEAT_MISS_LIMIT).toBeGreaterThan(INTERVAL_MS)
		expect(await raceSettled(connection.closed, INTERVAL_MS * 6)).toBe('open')
		connection.destroy()
	}, 30_000)
})

describe.skipIf(IS_WINDOWS)('bytes are proof of life, not whole frames', () => {
	it('keeps the HOST stream open while one big frame arrives in pieces', async () => {
		const agent = await startEchoingAgent({ echoHeartbeatMs: INTERVAL_MS })
		const connection = await transportTo(agent.port, INTERVAL_MS).openTcpConnection({ port: 9 })
		const chunks: Uint8Array[] = []
		connection.onData((chunk) => chunks.push(chunk))
		const frame = __framing.frame(
			JSON.stringify({ type: 'data', data: BIG_PAYLOAD.toString('base64') }),
		)
		// The agent writes NOTHING else for the whole dribble — no heartbeat,
		// no second frame — so the pieces are the only evidence it is there,
		// and the last one lands long after the three-interval window.
		expect(INTERVAL_MS * DRIBBLE_PIECES).toBeGreaterThan(INTERVAL_MS * STREAM_HEARTBEAT_MISS_LIMIT)
		await agent.dribble(frame, DRIBBLE_PIECES, INTERVAL_MS)
		expect(await raceSettled(connection.closed, INTERVAL_MS)).toBe('open')
		await vi.waitFor(() => expect(Buffer.concat(chunks).byteLength).toBe(BIG_PAYLOAD.byteLength), {
			timeout: 5_000,
		})
		connection.destroy()
	}, 30_000)

	it('keeps the GUEST stream open while one big frame arrives in pieces', async () => {
		const port = await startAgent()
		const upstream = await startUpstream()
		const client = await openRawTcpStream(port, upstream.port, INTERVAL_MS)
		expect(client.ready).toMatchObject({ type: 'ready', heartbeatMs: INTERVAL_MS })
		const frame = encodeFrame(
			JSON.stringify({ type: 'data', data: BIG_PAYLOAD.toString('base64') }),
		)
		await client.dribble(frame, DRIBBLE_PIECES, INTERVAL_MS)
		// The guest saw no complete frame for eight intervals and forwarded
		// every byte anyway; had it counted frames it would have destroyed this
		// socket, and its loopback connection with it, after three.
		await vi.waitFor(() => expect(upstream.read()).toBe(BIG_PAYLOAD.byteLength), { timeout: 5_000 })
		expect(upstream.live()).toBe(1)
		client.close()
	}, 30_000)
})

/**
 * Drive a `tcp-connect` with a RAW framed client that asks for no heartbeat
 * — a host built before this change — and return every frame the agent wrote
 * during `windowMs`.
 */
async function collectTerminalFrames(
	agentPort: number,
	upstreamPort: number,
	windowMs: number,
): Promise<Record<string, unknown>[]> {
	const socket = net.connect({ host: '127.0.0.1', port: agentPort })
	const frames: Record<string, unknown>[] = []
	let rest: Buffer = Buffer.alloc(0)
	socket.on('error', () => {})
	socket.on('data', (chunk) => {
		const decoded = decodeFrames(rest.length === 0 ? chunk : Buffer.concat([rest, chunk]))
		for (const payload of decoded.frames) {
			if (payload.length > 0) frames.push(JSON.parse(payload) as Record<string, unknown>)
		}
		rest = decoded.rest
	})
	await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
	socket.write(
		encodeFrame(
			JSON.stringify({
				op: 'tcp-connect',
				body: { host: '127.0.0.1', port: upstreamPort },
				token: POD_UID,
			}),
		),
	)
	await delay(windowMs)
	socket.destroy()
	return frames
}

describe('the backend opts in, and says so when it cannot', () => {
	it('defaults to 15 s and takes 0 as off', () => {
		expect(resolveStreamHeartbeatMs(undefined)).toBe(DEFAULT_STREAM_HEARTBEAT_MS)
		expect(DEFAULT_STREAM_HEARTBEAT_MS).toBe(15_000)
		// `0` restores exactly the behaviour every release before this one
		// had, which is why it is accepted here and refused for the API bound.
		expect(resolveStreamHeartbeatMs(0)).toBe(0)
		expect(resolveStreamHeartbeatMs(2_000)).toBe(2_000)
	})

	it.each([-1, 1.5, Number.NaN])('refuses %p', (value) => {
		expect(() => resolveStreamHeartbeatMs(value)).toThrow(/streamHeartbeatMs/)
	})
})
