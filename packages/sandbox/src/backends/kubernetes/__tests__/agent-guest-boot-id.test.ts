/**
 * The guest half of "which agent PROCESS answered": `guestBootId`, driven
 * against the REAL `agent/agent.cjs` over a real TCP connection.
 *
 * The pod uid is the bind token, and it is the wrong thing to ask this
 * question of. When the kubelet restarts a crashed container it brings the
 * image back up INSIDE the same pod: the uid does not move, so the token
 * still works, every call still succeeds, and every process the caller
 * started is gone with no reply saying so. Nothing in the Kubernetes API
 * reports it either — the pod object is unchanged.
 *
 * So the agent reports its own process identity on the replies it was
 * already sending. These cases pin the two properties a host depends on:
 *
 *  - it is on EVERY authenticated reply shape, including the refusals, so a
 *    host never has to make a second call to find out;
 *  - it is the SAME value for the life of the process, so a host comparing
 *    two replies is comparing processes rather than requests.
 *
 * And the one property an OLD host depends on: `healthz` is unauthenticated
 * and carries no identity at all, only the `guest-boot-id` feature string a
 * host uses to decide whether it may require the field.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import { decodeFrames, encodeFrame, sendFramedRequest } from './fixtures/framed-agent-client.js'

const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'

interface AgentModule {
	AGENT_FEATURES: string[]
	GUEST_BOOT_ID: string
	FIRECRACKER_AGENT_PROTOCOL_VERSION: number
	startListening(): Promise<Server>
}

/** A pod uid is what the downward API actually delivers; shaped like one. */
const POD_UID = '6f0b5d2e-2f3a-4b8c-9d1e-77aa0c4f1b32'
/** A v4-UUID-shaped execution id, which the host's parser requires. */
const EXECUTION_ID = 'exec_2c4f6a18-9b3d-4e77-8a51-0f6d2b3c9e14'

let workDir: string
let listener: Server | undefined
let agent: AgentModule
let port: number
let saved: Record<string, string | undefined>
const closers: (() => void)[] = []

function loadAgent(): AgentModule {
	delete require_.cache[require_.resolve(AGENT_PATH)]
	return require_(AGENT_PATH) as AgentModule
}

beforeEach(async () => {
	saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	for (const key of AGENT_ENV_KEYS) delete process.env[key]
	workDir = realpathSync(mkdtempSync(join(tmpdir(), 'k8s-agent-boot-')))
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	process.env.NAMZU_AGENT_TCP_PORT = '0'
	process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
	agent = loadAgent()
	listener = await agent.startListening()
	port = (listener.address() as AddressInfo).port
})

afterEach(async () => {
	for (const close of closers.splice(0)) close()
	if (listener) {
		await new Promise<void>((resolve) => listener?.close(() => resolve()))
		listener = undefined
	}
	for (const key of AGENT_ENV_KEYS) delete process.env[key]
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	rmSync(workDir, { recursive: true, force: true })
})

/** The boot id off one reply, or `undefined` when the reply carried none. */
function bootIdOf(reply: Record<string, unknown>): unknown {
	return reply.guestBootId
}

/**
 * Open one STREAM op and read frames until `ready`, then hand the socket
 * back so the case can close it.
 *
 * A terminal and a TCP stream never answer and end the way a control op
 * does — they stay open — so `sendFramedRequest`, which reads until close,
 * cannot be used for either.
 */
async function openStream(request: unknown): Promise<Record<string, unknown>> {
	const { connect } = await import('node:net')
	const socket = connect({ host: '127.0.0.1', port })
	closers.push(() => socket.destroy())
	let ready: Record<string, unknown> | undefined
	let rest: Buffer = Buffer.alloc(0)
	socket.on('error', () => {
		// A case that closes its own socket mid-stream is normal here.
	})
	socket.on('data', (chunk) => {
		const decoded = decodeFrames(rest.length === 0 ? chunk : Buffer.concat([rest, chunk]))
		for (const payload of decoded.frames) {
			if (payload.length === 0) continue
			const event = JSON.parse(payload) as Record<string, unknown>
			if (event.type === 'ready') ready ??= event
		}
		rest = decoded.rest
	})
	await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
	socket.write(encodeFrame(JSON.stringify(request)))
	await vi.waitFor(() => expect(ready).toBeDefined(), { timeout: 10_000 })
	if (ready === undefined) throw new Error('the agent never answered ready')
	return ready
}

describe('the guest reports which agent process answered', () => {
	it('advertises the capability so a host may require the field', () => {
		// Advertised rather than version-fenced: a host that wants to insist
		// on the evidence asks `healthz` first, and every host that does not
		// care goes on ignoring a field it never names. Bumping the protocol
		// version instead would strand every deployed guest for a feature
		// none of them has to use.
		expect(agent.AGENT_FEATURES).toContain('guest-boot-id')
	})

	it('carries no identity on healthz, which is unauthenticated', async () => {
		// The one op that answers without a token. A boot id there would be a
		// process identity handed to anything that can reach the port, and
		// readiness probing is exactly what reaches it.
		const health = await sendFramedRequest(port, { op: 'healthz' })

		expect(health.reply.ok).toBe(true)
		expect(bootIdOf(health.reply)).toBeUndefined()
		expect(health.reply.features).toContain('guest-boot-id')
	})

	it('carries the same id on every authenticated reply shape', async () => {
		writeFileSync(join(workDir, 'note.txt'), 'pod network', 'utf8')
		const seen: Record<string, unknown> = {}

		const written = await sendFramedRequest(port, {
			op: 'write-file',
			token: POD_UID,
			body: {
				path: join(workDir, 'written.txt'),
				content: Buffer.from('bytes', 'utf8').toString('base64'),
				encoding: 'base64',
			},
		})
		seen['write-file'] = bootIdOf(written.reply)

		const read = await sendFramedRequest(port, {
			op: 'read-file',
			token: POD_UID,
			body: { path: join(workDir, 'note.txt'), encoding: 'base64' },
		})
		seen['read-file'] = bootIdOf(read.reply)

		const reserved = await sendFramedRequest(port, {
			op: 'reserve-execution',
			token: POD_UID,
			body: { executionId: EXECUTION_ID },
		})
		seen['reserve-execution'] = bootIdOf(reserved.reply)

		const cancelled = await sendFramedRequest(port, {
			op: 'cancel-execution',
			token: POD_UID,
			body: { executionId: EXECUTION_ID },
		})
		seen['cancel-execution'] = bootIdOf(cancelled.reply)

		// The refusal for an id this process has never heard of — the single
		// most important shape to carry an identity, because it is exactly
		// what a RESTARTED agent answers about a command the previous process
		// was running.
		const unknown = await sendFramedRequest(port, {
			op: 'cancel-execution',
			token: POD_UID,
			body: { executionId: 'exec_00000000-0000-4000-8000-000000000000' },
		})
		expect(unknown.reply.error).toBe('unknown_execution')
		seen['cancel-execution/unknown'] = bootIdOf(unknown.reply)

		// And the two STREAM shapes, whose only reply is their opening frame.
		const upstream = createServer((socket) => socket.end())
		await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
		closers.push(() => upstream.close())
		const tcpReady = await openStream({
			op: 'tcp-connect',
			token: POD_UID,
			body: { host: '127.0.0.1', port: (upstream.address() as AddressInfo).port },
		})
		seen['tcp-connect/ready'] = bootIdOf(tcpReady)

		// Every shape, one value, and it is the process's own.
		expect(Object.values(seen)).toEqual(Object.values(seen).map(() => agent.GUEST_BOOT_ID))
		expect(agent.GUEST_BOOT_ID).toMatch(/^[0-9a-f-]{36}$/)
	}, 30_000)

	// Linux only, for the reason every PTY case in this package is: the
	// terminal is util-linux `script` plus /proc.
	it.skipIf(process.platform !== 'linux')(
		'carries it on a terminal stream opening frame',
		async () => {
			const ready = await openStream({
				op: 'terminal',
				token: POD_UID,
				body: { cols: 80, rows: 24, cwd: workDir, command: '/bin/sh', args: ['-c', 'sleep 2'] },
			})

			expect(ready.type).toBe('ready')
			expect(bootIdOf(ready)).toBe(agent.GUEST_BOOT_ID)
		},
		30_000,
	)

	it('mints a different id for a different agent process', async () => {
		// The whole point: the value dies with the process that minted it.
		// A container restarted in place keeps its pod, its uid and its bind
		// token, so this is the ONLY thing on the wire that changes.
		const first = agent.GUEST_BOOT_ID
		const restarted = loadAgent()

		expect(restarted.GUEST_BOOT_ID).not.toBe(first)
		expect(restarted.GUEST_BOOT_ID).toMatch(/^[0-9a-f-]{36}$/)
	})
})
