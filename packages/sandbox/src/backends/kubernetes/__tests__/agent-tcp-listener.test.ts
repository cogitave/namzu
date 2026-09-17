/**
 * The guest agent's third listen mode: a TCP port on the pod network.
 *
 * A sandbox that lives in a pod is reached over a routed network, not
 * over a host-local socket, so `agent/agent.cjs` — the same guest the
 * Firecracker tier bakes into its golden image — gains a
 * `NAMZU_AGENT_TCP_PORT` branch. Nothing below the socket moves: these
 * cases drive the REAL agent over a real TCP connection and assert the
 * same 8-hex framed wire, the same `healthz` reply and the same
 * protocol version the vsock listener serves.
 *
 * The branch is third, deliberately: a Firecracker guest whose rootfs
 * sets `NAMZU_AGENT_UNIX_PATH` or passes the vsock fd keeps landing on
 * exactly the branch it landed on before, whatever else is in its
 * environment.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, type Socket, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { localIpcPath } from '../../firecracker/__tests__/fixtures/ipc-path.js'
import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import { decodeFrames, encodeFrame, sendFramedRequest } from './fixtures/framed-agent-client.js'

const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'

interface AgentModule {
	AGENT_FEATURES: string[]
	FIRECRACKER_AGENT_PROTOCOL_VERSION: number
	handleConnection(socket: Socket): void
	startListening(): Promise<Server>
}

// Every knob the agent reads, not the handful this file sets: the agent
// reads them at module load, so one left over from the ambient shell
// decides a case here just as firmly as one a case sets on purpose.
const MANAGED_ENV = AGENT_ENV_KEYS

/** A pod uid is what the downward API actually delivers; shaped like one. */
const POD_UID = '6f0b5d2e-2f3a-4b8c-9d1e-77aa0c4f1b32'

let workDir: string
let listener: Server | undefined
let saved: Record<string, string | undefined>

function clearEnv(keys: readonly string[]): void {
	for (const key of keys) {
		// Unset, not emptied: the agent reads these straight off
		// process.env, where an empty string is not the same as absent.
		delete process.env[key]
	}
}

/** Load a FRESH agent module, so module-level listen state never leaks between cases. */
function loadAgent(): AgentModule {
	delete require_.cache[require_.resolve(AGENT_PATH)]
	return require_(AGENT_PATH) as AgentModule
}

beforeEach(() => {
	saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]))
	clearEnv(MANAGED_ENV)
	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-agent-tcp-')))
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
})

afterEach(async () => {
	if (listener) {
		await new Promise<void>((resolve) => listener?.close(() => resolve()))
		listener = undefined
	}
	clearEnv(MANAGED_ENV)
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	rmSync(workDir, { recursive: true, force: true })
})

describe('agent listen modes', () => {
	// In a token mode, because that is the only way this listener is
	// allowed to exist: a routed port with no credential is refused at
	// startup (below). `healthz` itself still presents nothing — readiness
	// probing must work without a secret.
	it('serves a framed healthz round trip over TCP', async () => {
		process.env.NAMZU_AGENT_TCP_PORT = '0'
		process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
		const agent = loadAgent()

		listener = await agent.startListening()
		const address = listener.address() as AddressInfo

		// 0.0.0.0, not loopback: the pod's own address is assigned at
		// admission and is not knowable inside the guest.
		expect(address.address).toBe('0.0.0.0')
		const exchange = await sendFramedRequest(address.port, { op: 'healthz' })
		expect(exchange.reply).toEqual({
			ok: true,
			protocolVersion: agent.FIRECRACKER_AGENT_PROTOCOL_VERSION,
			features: agent.AGENT_FEATURES,
		})
		// Pinned, not read back: adding a listen mode is not a wire change,
		// so no host and no golden image has to roll with it.
		expect(agent.FIRECRACKER_AGENT_PROTOCOL_VERSION).toBe(2)
	})

	it('round-trips a file over TCP with the same framing as the vsock listener', async () => {
		process.env.NAMZU_AGENT_TCP_PORT = '0'
		process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
		const agent = loadAgent()

		listener = await agent.startListening()
		const { port } = listener.address() as AddressInfo
		const written = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: join(workDir, 'note.txt'),
				content: Buffer.from('pod network', 'utf8').toString('base64'),
				encoding: 'base64',
			},
		})
		expect(written.reply).toEqual({
			ok: true,
			guestBootId: expect.any(String),
			bytesWritten: 11,
		})

		const read = await sendFramedRequest(port, {
			op: 'read-file',
			token: POD_UID,
			body: { path: join(workDir, 'note.txt'), encoding: 'base64' },
		})
		expect(read.reply.ok).toBe(true)
		expect(Buffer.from(String(read.reply.content), 'base64').toString('utf8')).toBe('pod network')
	})

	// The reader behind this wire takes a frame header as a fixed nine
	// bytes, so that bytes which are never going to become one are refused
	// instead of buffered against a newline that never arrives. Delivery
	// that falls inside a header, and then inside a body, is what must keep
	// working across that: the host writes one frame, the network decides
	// how many pieces it arrives in.
	it('reassembles a request split across writes at every boundary', async () => {
		process.env.NAMZU_AGENT_TCP_PORT = '0'
		process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
		const agent = loadAgent()

		listener = await agent.startListening()
		const { port } = listener.address() as AddressInfo
		const request = encodeFrame(
			JSON.stringify({
				op: 'write-file',
				token: POD_UID,
				body: {
					path: join(workDir, 'drip.txt'),
					content: Buffer.from('one byte at a time', 'utf8').toString('base64'),
					encoding: 'base64',
				},
			}),
		)
		const socket = connect({ host: '127.0.0.1', port })
		socket.setNoDelay(true)
		socket.on('error', () => {})
		const frames: string[] = []
		let rest: Buffer = Buffer.alloc(0)
		socket.on('data', (chunk: Buffer) => {
			const decoded = decodeFrames(rest.length === 0 ? chunk : Buffer.concat([rest, chunk]))
			frames.push(...decoded.frames)
			rest = decoded.rest
		})
		await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
		// Boundaries mid-prefix, on the newline, just past it, and mid-body.
		let written = 0
		for (const boundary of [4, 8, 9, 40, request.length]) {
			socket.write(request.subarray(written, boundary))
			written = boundary
			await delay(5)
		}
		await delay(200)
		socket.destroy()

		expect(frames.map((f) => JSON.parse(f))).toEqual([
			{ ok: true, guestBootId: expect.any(String), bytesWritten: 18 },
		])
	})

	it('rejects startup naming all three listen variables when none is set', async () => {
		const agent = loadAgent()

		await expect(agent.startListening()).rejects.toThrow(
			/NAMZU_AGENT_UNIX_PATH, NAMZU_AGENT_VSOCK_PORT or NAMZU_AGENT_TCP_PORT/,
		)
	})

	it('refuses a TCP port that is not a port rather than listening somewhere else', async () => {
		process.env.NAMZU_AGENT_TCP_PORT = 'eighty'
		const agent = loadAgent()

		await expect(agent.startListening()).rejects.toThrow(/must be an integer port/)
	})

	// Fail closed. An unauthenticated unix socket is reachable only by
	// something already inside the guest's mount namespace; an
	// unauthenticated TCP port is reachable by whatever the network
	// admits, and the agent used to bind one and say nothing.
	it('refuses a TCP listener with no credential, naming both variables', async () => {
		process.env.NAMZU_AGENT_TCP_PORT = '0'
		const agent = loadAgent()

		await expect(agent.startListening()).rejects.toThrow(
			/NAMZU_AGENT_BIND_TOKEN.*NAMZU_AGENT_REQUIRE_TOKEN/s,
		)
	})

	it('accepts a TCP listener whose credential is the first-token fallback', async () => {
		process.env.NAMZU_AGENT_TCP_PORT = '0'
		process.env.NAMZU_AGENT_REQUIRE_TOKEN = '1'
		const agent = loadAgent()

		listener = await agent.startListening()

		expect((listener.address() as AddressInfo).address).toBe('0.0.0.0')
	})

	// An empty value is what a downward-API injection looks like when it
	// resolved to nothing, so it is a misconfiguration in every mode and
	// not just on the routed one — asserted here on the unix branch, which
	// would otherwise have bound quite happily.
	it('refuses an empty NAMZU_AGENT_BIND_TOKEN whatever the listen mode', async () => {
		process.env.NAMZU_AGENT_UNIX_PATH = localIpcPath(workDir)
		process.env.NAMZU_AGENT_BIND_TOKEN = ''
		const agent = loadAgent()

		await expect(agent.startListening()).rejects.toThrow(/NAMZU_AGENT_BIND_TOKEN is set but empty/)
	})

	it('keeps the unix branch ahead of the TCP branch', async () => {
		const unixPath = localIpcPath(workDir)
		process.env.NAMZU_AGENT_UNIX_PATH = unixPath
		process.env.NAMZU_AGENT_TCP_PORT = '0'
		const agent = loadAgent()

		listener = await agent.startListening()

		expect(listener.address()).toBe(unixPath)
	})
})
