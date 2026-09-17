/**
 * A workspace command that outlives the connection watching it.
 *
 * The guest is the REAL `agent/agent.cjs` on a loopback socket and the
 * commands are real processes, because everything this feature claims is
 * about what happens to a running process when a socket goes away — a
 * scripted peer cannot be wrong about that in the way that matters.
 *
 * Four things are proved here and nowhere else:
 *
 *  - The retained log is the ONLY copy of a detached command's output, so
 *    its gap reporting and its eviction are asserted directly against
 *    `OutputLog` as well as through the wire.
 *  - The cursor a reattach resumes from is the GUEST's, never arithmetic
 *    over what the host decoded. Two cases run a command that splits one
 *    3-byte character across two writes, which is the shape that makes
 *    the two disagree, and a third pins the offsets onto the wire.
 *  - `attach-execution` is a read-only observer. The easiest possible bug
 *    is to build it out of the cancel path's plumbing and inherit
 *    "terminate on close", so a case closes an attach and then watches the
 *    command finish anyway.
 *  - A lost connection costs the workspace NOTHING. The cases that break
 *    the agent port layer the fake API server underneath and assert zero
 *    PATCH requests, because the behaviour being replaced sent
 *    `operatingMode: Suspended` and took the pod — and the caller's
 *    terminals — with it.
 *
 * Why the `cat` shim: `createKubernetesWorkspace` gates on the acquire-time
 * privilege probe, which runs `cat /proc/self/status` IN THE GUEST, and the
 * test host's node process is correctly not deprivileged. The real agent
 * spawns the command through the host's PATH, so a shim `cat` earlier on
 * PATH lets these cases drive the real workspace surface over the real
 * agent. Nothing in this file runs `cat` for any other purpose.
 */

import { once } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, type Socket, connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	KubernetesExecutionDetachedError,
	KubernetesExecutionNotAttachableError,
} from '../transport.js'
import { KubernetesAgentTransport } from '../transport.js'
import { type KubernetesWorkspace, createKubernetesWorkspace } from '../workspace.js'
import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { decodeFrames, encodeFrame, sendFramedRequest } from './fixtures/framed-agent-client.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { DEPRIVILEGED_PROC_STATUS } from './fixtures/scripted-agent.js'

const IS_WINDOWS = process.platform === 'win32'
const require_ = createRequire(import.meta.url)
const AGENT_PATH = '../../../../agent/agent.cjs'

const NAMESPACE = 'namzu-sandboxes'
const WORKSPACE_ID = 'detach-demo'
const WORKSPACE_NAME = 'namzu-ws-detach-demo'
const POD_UID = '5b8a1c92-4d0e-4a77-9f31-6c2b7e40a913'
/** A caller-chosen id, in the shape the guest accepts. This is "X". */
const EXECUTION_X = 'exec_1f2e3d4c-5b6a-4c8d-9e0f-112233445566'
/**
 * A command that writes ONE 3-byte character as two separate writes, so
 * the guest logs 2 bytes and then 1 and the host decodes two replacement
 * characters — 6 bytes of string standing for 3 bytes of log. It is the
 * shape a 64 KiB pipe read produces on any output that is not ASCII, and
 * the reason a reattach cursor may never be derived from decoded text.
 */
const SPLIT_CHARACTER = 'printf "\\342\\234"; sleep 0.2; printf "\\224"'

/** Write framed JSON events, then the zero-length terminator. */
function writeStream(socket: Socket, ...events: unknown[]): void {
	for (const event of events) socket.write(encodeFrame(JSON.stringify(event)))
	socket.write(encodeFrame(''))
	socket.end()
}

/** Every frame an exchange carried, parsed; the terminator dropped. */
function framesOf(exchange: { frames: string[] }): Record<string, unknown>[] {
	return exchange.frames
		.filter((payload) => payload.length > 0)
		.map((payload) => JSON.parse(payload) as Record<string, unknown>)
}

interface AgentModule {
	AGENT_FEATURES: string[]
	MAX_TIMEOUT_MS: number
	handleConnection(socket: Socket): void
	resolveTimeoutMs(raw: unknown): number
	OutputLog: new (
		maxBytes: number,
	) => {
		append(stream: string, data: Buffer): number
		discard(): void
		startOffset: number
		endOffset: number
		droppedBytes: number
		read(fromOffset: number):
			| {
					chunks: { stream: string; data: Buffer; offset: number }[]
					droppedBytes: number
					fromOffset: number
					nextOffset: number
			  }
			| undefined
	}
}

let workDir: string
let shimDir: string
let agent: AgentModule
let listener: Server | undefined
let agentPort = 0
let accepted: Socket[] = []
let extraSockets: Socket[] = []
let apiServer: FakeApiServer | undefined
let restoreDns: (() => void) | undefined
let saved: Record<string, string | undefined>
let savedPath: string | undefined

function clearEnv(): void {
	for (const key of AGENT_ENV_KEYS) delete process.env[key]
}

/** Put the agent behind a loopback listener we can take away and give back. */
async function listen(port = 0): Promise<Server> {
	const server = createServer((socket) => {
		accepted.push(socket)
		agent.handleConnection(socket)
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, '127.0.0.1', () => resolve())
	})
	return server
}

/** Load a FRESH agent module: its registry and config are module state. */
async function startAgent(env: Record<string, string> = {}): Promise<void> {
	clearEnv()
	process.env.NAMZU_AGENT_BIND_TOKEN = POD_UID
	process.env.NAMZU_SANDBOX_WORKSPACE = workDir
	for (const [key, value] of Object.entries(env)) process.env[key] = value
	delete require_.cache[require_.resolve(AGENT_PATH)]
	agent = require_(AGENT_PATH) as AgentModule
	accepted = []
	listener = await listen()
	agentPort = (listener.address() as AddressInfo).port
}

/**
 * Break the agent's port the way a pod-network blip does: every open
 * connection is severed and every new dial is REFUSED, for as long as the
 * outage lasts. The guest keeps running — this is the host's side of the
 * wire going away, not the pod.
 */
async function severAgentPort(forMs: number): Promise<void> {
	for (const socket of accepted) socket.destroy()
	accepted = []
	const server = listener
	listener = undefined
	if (server) {
		server.close()
		await once(server, 'close')
	}
	await delay(forMs)
	listener = await listen(agentPort)
}

function transport(): KubernetesAgentTransport {
	return new KubernetesAgentTransport({
		kind: 'tcp',
		host: '127.0.0.1',
		port: agentPort,
		token: POD_UID,
	})
}

/** A cluster that answers the whole workspace lifecycle and nothing else. */
async function startCluster(): Promise<FakeApiServer> {
	return await startFakeApiServer((req: RecordedRequest): FakeApiReply => {
		if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
			return {
				status: 200,
				body: {
					metadata: { name: 'namzu-workspace', namespace: NAMESPACE },
					spec: {
						service: true,
						volumeClaimTemplates: [
							{
								metadata: { name: 'workspace' },
								spec: {
									accessModes: ['ReadWriteOnce'],
									volumeMode: 'Block',
									resources: { requests: { storage: '20Gi' } },
								},
							},
						],
						podTemplate: {
							spec: {
								containers: [
									{
										name: 'main',
										image: 'namzu/agent:test',
										volumeDevices: [{ name: 'workspace', devicePath: '/dev/workspace' }],
									},
								],
							},
						},
					},
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
			return { status: 404, body: { message: 'not found' } }
		}
		if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
			return { status: 201, body: {} }
		}
		if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
			return {
				status: 200,
				body: {
					metadata: { name: WORKSPACE_NAME },
					spec: { operatingMode: 'Running' },
					status: {
						conditions: [readyCondition()],
						podIPs: ['127.0.0.1'],
						serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
						selector: 'agents.x-k8s.io/sandbox-name-hash=ws1',
					},
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods/')) {
			return { status: 200, body: { metadata: { name: WORKSPACE_NAME, uid: POD_UID } } }
		}
		return { status: 404, body: { message: 'unexpected' } }
	})
}

async function openWorkspace(): Promise<KubernetesWorkspace> {
	apiServer = await startCluster()
	restoreDns = stubLoopbackDns()
	return await createKubernetesWorkspace(
		{
			access: { server: apiServer.url, getToken: async () => 'sa-token' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-workspace',
			agentPort,
			readyTimeoutMs: 5_000,
			readyPollIntervalMs: 5,
			ingress: 'unverified' as const,
		},
		{ workspaceId: WORKSPACE_ID, workingDirectory: workDir },
	)
}

/** Every `spec.operatingMode` write this cluster was asked to make. */
function patchesSent(): readonly RecordedRequest[] {
	return apiServer ? apiServer.matching('PATCH', '/sandboxes/') : []
}

beforeEach(() => {
	saved = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
	savedPath = process.env.PATH
	workDir = mkdtempSync(join(tmpdir(), 'namzu-attach-'))
	shimDir = mkdtempSync(join(tmpdir(), 'namzu-shim-'))
	// See the file header. The probe's `cat` and nothing else.
	writeFileSync(
		join(shimDir, 'cat'),
		`#!/bin/sh\nprintf '%s' '${DEPRIVILEGED_PROC_STATUS.replace(/'/g, "'\\''")}'\n`,
	)
	chmodSync(join(shimDir, 'cat'), 0o755)
	process.env.PATH = `${shimDir}:${savedPath ?? ''}`
})

afterEach(async () => {
	for (const socket of [...accepted, ...extraSockets]) socket.destroy()
	accepted = []
	extraSockets = []
	if (listener) {
		listener.close()
		await once(listener, 'close').catch(() => undefined)
	}
	listener = undefined
	restoreDns?.()
	restoreDns = undefined
	await apiServer?.close()
	apiServer = undefined
	clearEnv()
	for (const [key, value] of Object.entries(saved)) {
		if (value !== undefined) process.env[key] = value
	}
	if (savedPath !== undefined) process.env.PATH = savedPath
	rmSync(workDir, { recursive: true, force: true })
	rmSync(shimDir, { recursive: true, force: true })
})

describe('the retained-output primitive', () => {
	it('reports the bytes a reader missed instead of handing back a shorter stream', async () => {
		await startAgent()
		const log = new agent.OutputLog(8)
		log.append('stdout', Buffer.from('aaaa'))
		log.append('stdout', Buffer.from('bbbb'))
		log.append('stdout', Buffer.from('cccc'))

		// 12 bytes were appended, 8 survive, so a reader starting at 0 is
		// four bytes behind — and is TOLD so, by count.
		const replay = log.read(0)
		expect(replay?.droppedBytes).toBe(4)
		expect(replay?.fromOffset).toBe(4)
		expect(replay?.nextOffset).toBe(12)
		expect(replay?.chunks.map((chunk) => chunk.data.toString('utf8')).join('')).toBe('bbbbcccc')
		// A reader that is caught up sees no gap and no output.
		expect(log.read(12)).toMatchObject({ droppedBytes: 0, chunks: [] })
	})

	it('slices a chunk larger than the whole budget rather than keeping it whole', async () => {
		await startAgent()
		const log = new agent.OutputLog(4)
		log.append('stdout', Buffer.from('0123456789'))
		expect(
			log
				.read(0)
				?.chunks.map((chunk) => chunk.data.toString('utf8'))
				.join(''),
		).toBe('6789')
		expect(log.droppedBytes).toBe(6)
		// The offsets still describe the whole history, which is what makes a
		// stale cursor answerable rather than meaningless.
		expect(log.startOffset).toBe(6)
		expect(log.endOffset).toBe(10)
	})

	it('refuses an offset that names bytes the command has not produced', async () => {
		await startAgent()
		const log = new agent.OutputLog(64)
		log.append('stdout', Buffer.from('ab'))
		expect(log.read(3)).toBeUndefined()
		expect(log.read(-1)).toBeUndefined()
	})
})

describe('the wire the guest speaks', () => {
	it('advertises the capability and leaves the default reservation reply alone', async () => {
		await startAgent()
		expect(agent.AGENT_FEATURES).toContain('execution-attach')

		const health = await sendFramedRequest(agentPort, { op: 'healthz' })
		expect(health.reply.features).toContain('execution-attach')

		// A reserve with no caller id carries none of the ATTACH fields it
		// always lacked: no `state`, no retention fields. `guestBootId` is
		// beside them and is not one of them — it rides on every
		// authenticated reply in this agent, whatever the op asked for.
		const plain = await sendFramedRequest(agentPort, {
			op: 'reserve-execution',
			token: POD_UID,
		})
		expect(plain.reply.ok).toBe(true)
		expect(plain.reply.state).toBeUndefined()
		expect(Object.keys(plain.reply).sort()).toEqual([
			'executionId',
			'guestBootId',
			'leaseExpiresAt',
			'ok',
			'protocolVersion',
		])
	})

	it('refuses retention for a command no id can name', async () => {
		await startAgent()
		const exchange = await sendFramedRequest(agentPort, {
			op: 'execute',
			token: POD_UID,
			body: { command: 'sh', args: ['-c', 'echo hi'], retainOutput: true },
		})
		expect(exchange.reply).toMatchObject({
			type: 'error',
			error: 'retain_requires_execution_id',
		})
	})

	it('stamps a retained delta with the bytes it occupies and an ordinary one with nothing', async () => {
		await startAgent()
		// An ordinary execute's deltas are the frames they have always been.
		const plain = await sendFramedRequest(agentPort, {
			op: 'execute',
			token: POD_UID,
			body: { command: 'sh', args: ['-c', 'printf ab'] },
		})
		const plainDelta = framesOf(plain).find((event) => event.type === 'stdout_delta')
		expect(plainDelta).toMatchObject({ data: 'ab' })
		expect(Object.keys(plainDelta ?? {}).sort()).toEqual(['data', 'type'])

		// A RETAINED one also carries the span the chunk occupies in the
		// log, because that is the only thing a reattach can resume from.
		// This command splits one 3-byte character across two writes: the
		// guest's log grows by 2 bytes and then 1, while the decoded strings
		// the host receives are replacement characters wider than the bytes
		// they stand for. A host counting what it decoded would ask to
		// resume at 6 in a log that ends at 3.
		await sendFramedRequest(agentPort, {
			op: 'reserve-execution',
			token: POD_UID,
			body: { executionId: EXECUTION_X },
		})
		const retained = await sendFramedRequest(agentPort, {
			op: 'execute',
			token: POD_UID,
			body: {
				executionId: EXECUTION_X,
				command: 'sh',
				args: ['-c', SPLIT_CHARACTER],
				retainOutput: true,
			},
		})
		const deltas = framesOf(retained).filter((event) => event.type === 'stdout_delta')
		expect(deltas.map((event) => [event.offset, event.nextOffset])).toEqual([
			[0, 2],
			[2, 3],
		])
		expect(
			deltas.reduce((total, event) => total + Buffer.byteLength(String(event.data), 'utf8'), 0),
		).toBeGreaterThan(3)
	})

	it('answers an attach to an execution it never had with unknown_execution', async () => {
		await startAgent()
		const exchange = await sendFramedRequest(agentPort, {
			op: 'attach-execution',
			token: POD_UID,
			body: { executionId: EXECUTION_X, fromOffset: 0 },
		})
		expect(exchange.reply).toMatchObject({ type: 'error', error: 'unknown_execution' })
	})
})

describe.skipIf(IS_WINDOWS)('a detached command', () => {
	it('replays its whole output to a second observer and answers every attach the same', async () => {
		await startAgent()
		const wire = transport()
		const result = await wire.execDetached(
			'sh',
			['-c', 'for i in 1 2 3 4 5; do echo $i; sleep 0.05; done'],
			{ executionId: EXECUTION_X, detach: true },
		)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('1\n2\n3\n4\n5\n')

		// A second process, holding only the id, reads the same command.
		const second = await transport().attachExecution(EXECUTION_X, { fromOffset: 0 })
		expect(second.exitCode).toBe(0)
		expect(second.stdout).toBe('1\n2\n3\n4\n5\n')
		expect(second.stdoutTruncated).toBe(false)

		// And again: an attach inside retention is not a one-shot read.
		const third = await transport().attachExecution(EXECUTION_X, { fromOffset: 0 })
		expect(third).toEqual(second)
	})

	it('runs the command once when the same id is started twice inside retention', async () => {
		await startAgent()
		const marker = join(workDir, 'once.txt')
		const command = ['-c', `echo line >> ${JSON.stringify(marker)}`]

		const first = await transport().execDetached('sh', command, {
			executionId: EXECUTION_X,
			detach: true,
		})
		const second = await transport().execDetached('sh', command, {
			executionId: EXECUTION_X,
			detach: true,
		})

		expect(first.exitCode).toBe(0)
		expect(second.exitCode).toBe(0)
		// The second call attached to the record the first left behind; it
		// did not spawn a second shell.
		expect(readFileSync(marker, 'utf8')).toBe('line\n')
	})

	it('loses nothing when a multi-byte character straddles the chunk the outage cut', async () => {
		await startAgent()
		const wire = transport()
		// The split character first, then a line every 200ms, so the
		// reattach lands well after the boundary that would have drifted
		// the cursor.
		const running = wire.execDetached(
			'sh',
			[
				'-c',
				`${SPLIT_CHARACTER}; echo; i=0; while [ $i -lt 12 ]; do echo "L$i"; i=$((i+1)); sleep 0.2; done`,
			],
			{ executionId: EXECUTION_X, detach: true, reattachWindowMs: 10_000 },
		)
		await delay(700)
		await severAgentPort(600)

		const result = await running
		expect(result.exitCode).toBe(0)
		// Every line the command wrote, in order and with none missing. A
		// cursor derived from the decoded string would have resumed PAST
		// bytes the guest still held, and they would have been reported
		// nowhere: a short stdout with both truncation flags false.
		//
		// The split character itself still arrives as two replacement
		// characters on the first line, because a chunk that ends inside a
		// UTF-8 sequence has always been decoded chunk by chunk. That is
		// the decoding, not the cursor, and it is unchanged here.
		expect(result.stdout.trimEnd().split('\n').slice(-12)).toEqual(
			Array.from({ length: 12 }, (_, index) => `L${index}`),
		)
		expect(result.stdoutTruncated).toBe(false)
		expect(result.stderrTruncated).toBe(false)
		// And it is byte for byte what the guest retained.
		const whole = await transport().attachExecution(EXECUTION_X, { fromOffset: 0 })
		expect(whole.stdout).toBe(result.stdout)
	})

	it('reattaches to a quiet command whose last output ended mid-character', async () => {
		await startAgent()
		const wire = transport()
		// The command goes QUIET after the split, so the log stops growing
		// while a drifted cursor is already past its end: the offset then
		// names bytes that will never exist, and the guest refuses it
		// outright rather than merely skipping ahead.
		const running = wire.execDetached(
			'sh',
			['-c', `${SPLIT_CHARACTER}; printf " mid\\n"; sleep 2; printf "tail\\n"`],
			{ executionId: EXECUTION_X, detach: true, reattachWindowMs: 10_000 },
		)
		await delay(700)
		await severAgentPort(600)

		const result = await running
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('mid\n')
		expect(result.stdout.endsWith('tail\n')).toBe(true)
	})

	it('reports the gap when a reader asks for output the guest has evicted', async () => {
		await startAgent({ NAMZU_AGENT_EXECUTION_LOG_BYTES: '16' })
		await transport().execDetached('sh', ['-c', 'for i in 1 2 3 4 5 6 7 8 9; do echo $i; done'], {
			executionId: EXECUTION_X,
			detach: true,
		})

		const gaps: { droppedBytes: number }[] = []
		const late = await transport().attachExecution(EXECUTION_X, {
			fromOffset: 0,
			onGap: (gap) => gaps.push(gap),
		})
		expect(gaps).toHaveLength(1)
		expect(gaps[0]?.droppedBytes).toBe(2)
		expect(late.stdout).toBe('2\n3\n4\n5\n6\n7\n8\n9\n')
		// A gap IS truncation: the contract's one way of saying "this is not
		// all of it" is set on both streams, because the retained log is one
		// interleaved space and the loss cannot be attributed to either.
		expect(late.stdoutTruncated).toBe(true)
		expect(late.stderrTruncated).toBe(true)
	})

	it('goes on running when an attached reader closes its connection', async () => {
		await startAgent()
		const marker = join(workDir, 'survived.txt')
		const wire = transport()
		const running = wire.execDetached(
			'sh',
			['-c', `sleep 0.6; echo done > ${JSON.stringify(marker)}; echo finished`],
			{ executionId: EXECUTION_X, detach: true },
		)
		// Give the command time to be admitted, then attach and walk away.
		await delay(150)
		const observer = connect({ host: '127.0.0.1', port: agentPort })
		extraSockets.push(observer)
		await once(observer, 'connect')
		observer.write(
			encodeFrame(
				JSON.stringify({
					op: 'attach-execution',
					token: POD_UID,
					body: { executionId: EXECUTION_X, fromOffset: 0 },
				}),
			),
		)
		await once(observer, 'data')
		observer.destroy()

		// Closing an attach is not a cancel, a signal, or anything at all.
		const result = await running
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('finished')
		expect(readFileSync(marker, 'utf8')).toBe('done\n')
	})

	it('reports cancelled to a later reader when another process ends it by id', async () => {
		await startAgent()
		const wire = transport()
		const running = wire.execDetached('sh', ['-c', 'echo starting; sleep 30'], {
			executionId: EXECUTION_X,
			detach: true,
		})
		await delay(250)

		// A different transport — a different host process, as far as the
		// guest is concerned — ends it by id.
		await transport().cancelExecution(EXECUTION_X)
		const result = await running
		expect(result.stdout).toContain('starting')

		const later = await transport().attachExecution(EXECUTION_X, { fromOffset: 0 })
		// The synthetic terminal the guest keeps for a cancelled command.
		expect(later.exitCode).not.toBe(0)
		expect(later.stdout).toContain('starting')
	})

	it("gives up a finished command's output to keep a new one, and says so", async () => {
		// One retained log at a time, so the second detached command has to
		// take the first one's slot.
		await startAgent({ NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS: '1' })
		const other = 'exec_2a3b4c5d-6e7f-4a8b-9c0d-223344556677'
		const first = await transport().execDetached('sh', ['-c', 'echo first'], {
			executionId: EXECUTION_X,
			detach: true,
		})
		expect(first.stdout).toBe('first\n')

		const second = await transport().execDetached('sh', ['-c', 'echo second'], {
			executionId: other,
			detach: true,
		})
		expect(second.stdout).toBe('second\n')

		// The first command's RESULT survives — it is what a late reader most
		// needs and costs nothing to keep. Its output does not, and the reader
		// is told exactly how much it lost rather than handed an empty stdout
		// that looks like a command which printed nothing.
		const gaps: { droppedBytes: number }[] = []
		const late = await transport().attachExecution(EXECUTION_X, {
			fromOffset: 0,
			onGap: (gap) => gaps.push(gap),
		})
		expect(gaps[0]?.droppedBytes).toBe('first\n'.length)
		expect(late.exitCode).toBe(0)
		expect(late.stdout).toBe('')
		expect(late.stdoutTruncated).toBe(true)
	})

	it("refuses a new detached command rather than drop a running one's output", async () => {
		await startAgent({ NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS: '1' })
		const other = 'exec_2a3b4c5d-6e7f-4a8b-9c0d-223344556677'
		const holding = transport().execDetached('sh', ['-c', 'echo holding; sleep 30'], {
			executionId: EXECUTION_X,
			detach: true,
		})
		await delay(250)

		// The only retained slot belongs to a LIVE command, whose output has
		// nowhere else to go, so the refusal happens before a second process
		// exists — not by quietly running it with nothing kept.
		const failure = await transport()
			.execDetached('sh', ['-c', 'echo second'], { executionId: other, detach: true })
			.catch((error: unknown) => error)
		expect((failure as Error).message).toMatch(/retained_output_capacity/)
		expect((failure as Error).message).toMatch(/NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS/)

		await transport().cancelExecution(EXECUTION_X)
		await holding
	})

	it('says the command never started when the reservation was never spent', async () => {
		await startAgent()
		// The window between a reserve and an execute that never arrived:
		// the record exists, and there is no log because there was never a
		// process. A host that reported this as "it may still be running"
		// would send its caller after a command that does not exist.
		await sendFramedRequest(agentPort, {
			op: 'reserve-execution',
			token: POD_UID,
			body: { executionId: EXECUTION_X },
		})

		const failure = await transport()
			.attachExecution(EXECUTION_X, { fromOffset: 0 })
			.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(KubernetesExecutionNotAttachableError)
		const refusal = failure as KubernetesExecutionNotAttachableError
		expect(refusal.reason).toBe('output_not_retained')
		expect(refusal.executionState).toBe('reserved')
		expect(refusal.message).toMatch(/never started/)
	})

	it('refuses an attach in the stream shape when the agent has fenced itself', async () => {
		await startAgent()
		// A command whose process group outlives its leader is what fences
		// the agent: it can no longer say what it owns, so it refuses reuse.
		// The background process gives up the command's stdio, or the
		// agent would not see the leader close until it had exited too.
		await sendFramedRequest(agentPort, {
			op: 'execute',
			token: POD_UID,
			body: { command: 'sh', args: ['-c', 'sleep 1 >/dev/null 2>&1 & exit 0'] },
		}).catch(() => undefined)
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const health = await sendFramedRequest(agentPort, { op: 'healthz' })
			if (health.reply.retiring === true) break
			await delay(25)
		}

		// A fenced agent answers an attach the way an attach is READ — an
		// error frame and the terminator — rather than with a reply shape
		// its caller has no grammar for and could only report as a protocol
		// violation.
		const exchange = await sendFramedRequest(agentPort, {
			op: 'attach-execution',
			token: POD_UID,
			body: { executionId: EXECUTION_X },
		})
		expect(exchange.reply).toEqual({ type: 'error', error: 'agent_retiring' })
		expect(exchange.frames.at(-1)).toBe('')

		const failure = await transport()
			.attachExecution(EXECUTION_X, { fromOffset: 0 })
			.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(KubernetesExecutionNotAttachableError)
		expect((failure as KubernetesExecutionNotAttachableError).reason).toBe('agent_retiring')
	})

	it('attaches to the command that exists when another process won the start race', async () => {
		// A guest that has already admitted this id for somebody else. The
		// reservation still reads `reserved` to this caller — both hosts saw
		// it — and the `execute` is refused because a command is already
		// running under it. The answer a caller wants is that command, not
		// an error about a race it cannot see.
		const output = 'raced\n'
		const stand = createServer((socket) => {
			extraSockets.push(socket)
			let rest: Buffer = Buffer.alloc(0)
			socket.on('error', () => undefined)
			socket.on('data', (chunk) => {
				const decoded = decodeFrames(rest.length === 0 ? chunk : Buffer.concat([rest, chunk]))
				rest = decoded.rest
				for (const payload of decoded.frames) {
					if (payload.length === 0) continue
					const op = (JSON.parse(payload) as { op?: string }).op
					if (op === 'healthz') {
						socket.write(
							encodeFrame(
								JSON.stringify({
									ok: true,
									protocolVersion: 2,
									features: ['execution-attach'],
								}),
							),
						)
						socket.end()
					} else if (op === 'reserve-execution') {
						socket.write(
							encodeFrame(
								JSON.stringify({
									ok: true,
									protocolVersion: 2,
									executionId: EXECUTION_X,
									leaseExpiresAt: Date.now() + 60_000,
									state: 'reserved',
								}),
							),
						)
						socket.end()
					} else if (op === 'execute') {
						writeStream(socket, { type: 'error', error: 'execution_not_reserved: running' })
					} else if (op === 'attach-execution') {
						writeStream(
							socket,
							{
								type: 'attached',
								executionId: EXECUTION_X,
								state: 'running',
								fromOffset: 0,
								droppedBytes: 0,
							},
							{
								type: 'stdout_delta',
								data: output,
								offset: 0,
								nextOffset: Buffer.byteLength(output, 'utf8'),
							},
							{
								type: 'attach_result',
								executionId: EXECUTION_X,
								outcome: 'completed',
								started: true,
								result: { exitCode: 0, timedOut: false, durationMs: 7 },
								nextOffset: Buffer.byteLength(output, 'utf8'),
							},
						)
					}
				}
			})
		})
		await new Promise<void>((resolve) => stand.listen(0, '127.0.0.1', () => resolve()))
		const wire = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port: (stand.address() as AddressInfo).port,
			token: POD_UID,
		})

		const result = await wire.execDetached('sh', ['-c', 'echo raced'], {
			executionId: EXECUTION_X,
			detach: true,
		})
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe(output)
		stand.close()
	})

	it('refuses before the command is admitted when the guest cannot keep output', async () => {
		await startAgent()
		// A guest that never advertises the feature: healthz is answered by
		// a stand-in that speaks the pre-feature reply.
		const legacy = createServer((socket) => {
			extraSockets.push(socket)
			socket.on('data', () => {
				socket.write(encodeFrame(JSON.stringify({ ok: true, protocolVersion: 2 })))
				socket.end()
			})
		})
		await new Promise<void>((resolve) => legacy.listen(0, '127.0.0.1', () => resolve()))
		const port = (legacy.address() as AddressInfo).port
		const wire = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: POD_UID,
		})
		await expect(
			wire.execDetached('sh', ['-c', 'echo hi'], { executionId: EXECUTION_X, detach: true }),
		).rejects.toThrow(/execution-attach/)
		legacy.close()
	})
})

describe.skipIf(IS_WINDOWS)('the ceiling on a command timeout', () => {
	it('names the variable an operator raises, and refuses above the default', async () => {
		await startAgent()
		expect(agent.MAX_TIMEOUT_MS).toBe(30 * 60 * 1000)
		expect(() => agent.resolveTimeoutMs(45 * 60 * 1000)).toThrow(/NAMZU_SANDBOX_MAX_TIMEOUT_MS/)
	})

	it('accepts a timeout above thirty minutes once the operator has set it', async () => {
		await startAgent({ NAMZU_SANDBOX_MAX_TIMEOUT_MS: String(2 * 60 * 60 * 1000) })
		expect(agent.MAX_TIMEOUT_MS).toBe(2 * 60 * 60 * 1000)
		expect(agent.resolveTimeoutMs(45 * 60 * 1000)).toBe(45 * 60 * 1000)
	})
})

describe.skipIf(IS_WINDOWS)('a workspace whose agent port goes away', () => {
	it('gets its own command back by reattaching, and patches nothing', async () => {
		await startAgent()
		const workspace = await openWorkspace()
		const patchesBefore = patchesSent().length

		const running = workspace.exec(
			'sh',
			['-c', 'i=0; while [ $i -lt 9 ]; do echo $i; i=$((i+1)); sleep 2; done'],
			{ executionId: EXECUTION_X, detach: true },
		)
		await delay(1_000)
		// Longer than the eight-second window a cancel would be retried
		// for: the behaviour being replaced here would have reported the
		// cancel unconfirmed and suspended the workspace.
		await severAgentPort(15_000)

		const result = await running
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('0\n1\n2\n3\n4\n5\n6\n7\n8\n')
		expect(result.stdoutTruncated).toBe(false)
		expect(workspace.suspended).toBe(false)
		expect(workspace.status).toBe('ready')
		// Nothing was written to the object. Not a suspend, not anything.
		expect(patchesSent()).toHaveLength(patchesBefore)
	}, 60_000)

	it('names the execution it stopped watching, and hands the result to a later attach', async () => {
		await startAgent()
		const workspace = await openWorkspace()
		const patchesBefore = patchesSent().length

		const running = workspace.exec(
			'sh',
			['-c', 'i=0; while [ $i -lt 9 ]; do echo $i; i=$((i+1)); sleep 2; done'],
			{ executionId: EXECUTION_X, detach: true, reattachWindowMs: 2_000 },
		)
		await delay(1_000)
		const restored = severAgentPort(15_000)

		const failure = await running.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(KubernetesExecutionDetachedError)
		const detached = failure as KubernetesExecutionDetachedError
		expect(detached.executionId).toBe(EXECUTION_X)
		expect(detached.outputOffset).toBeGreaterThan(0)
		// It gave up WATCHING. It did not cancel, and it did not write.
		expect(patchesSent()).toHaveLength(patchesBefore)
		expect(workspace.suspended).toBe(false)

		await restored
		const result = await workspace.attachExecution(EXECUTION_X, { fromOffset: 0 })
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toBe('0\n1\n2\n3\n4\n5\n6\n7\n8\n')
		expect(patchesSent()).toHaveLength(patchesBefore)
	}, 60_000)

	it('tells a caller that the execution is past reach rather than inventing a result', async () => {
		await startAgent()
		const workspace = await openWorkspace()
		const failure = await workspace
			.attachExecution(EXECUTION_X, { fromOffset: 0 })
			.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(KubernetesExecutionNotAttachableError)
		expect((failure as KubernetesExecutionNotAttachableError).reason).toBe('unknown_execution')
		expect(patchesSent()).toHaveLength(0)
	})
})

describe.skipIf(IS_WINDOWS)('an ordinary workspace exec', () => {
	it('sends exactly the request it always sent and keeps no output', async () => {
		await startAgent()
		const sent: unknown[] = []
		const recorder = createServer((socket) => {
			accepted.push(socket)
			let rest: Buffer = Buffer.alloc(0)
			socket.on('data', (chunk) => {
				const decoded = decodeFrames(rest.length === 0 ? chunk : Buffer.concat([rest, chunk]))
				rest = decoded.rest
				for (const payload of decoded.frames) {
					if (payload.length > 0) sent.push(JSON.parse(payload))
				}
			})
			agent.handleConnection(socket)
		})
		await new Promise<void>((resolve) => recorder.listen(0, '127.0.0.1', () => resolve()))
		const port = (recorder.address() as AddressInfo).port
		const wire = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port,
			token: POD_UID,
		})

		const result = await wire.exec('sh', ['-c', 'echo plain'])
		expect(result.stdout).toBe('plain\n')

		const execute = sent.find((request) => (request as { op?: string }).op === 'execute') as {
			body: Record<string, unknown>
		}
		expect(execute.body.retainOutput).toBeUndefined()
		const reserve = sent.find(
			(request) => (request as { op?: string }).op === 'reserve-execution',
		) as Record<string, unknown>
		expect(reserve.body).toBeUndefined()
		recorder.close()
	})
})
