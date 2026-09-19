/**
 * What the guest agent does when its pod is stopped.
 *
 * **What the container's process tree actually is.** `k8s/entrypoint.sh`
 * `exec`s `setpriv` into `tini`, and `tini` starts the agent: `tini` is pid
 * 1 of the container's own pid namespace and the agent is its child. This
 * file used to say the opposite — that the entrypoint execs straight into
 * the agent, making the agent pid 1 — and reasoned from it that the handler
 * existed because the kernel leaves a "terminate" signal un-applied for pid
 * 1 with no handler installed. That stopped being true when `tini` was
 * introduced. The handler still matters, for an ordinary reason: without
 * one, the default disposition kills this process where a drain and a flush
 * have to run instead.
 *
 * **What the handler now owes a stopping pod.** A workspace's disk keeps
 * whatever the guest kernel happened to write back. Nothing in this agent
 * ever called `sync`, `syncfs` or `fsync`, and the two moments that most
 * need it — the suspend that takes the pod away, and a stop the cluster
 * performs for its own reasons — are exactly the two where nothing was
 * asked of it. So, in this order and asserted here in this order: stop
 * accepting connections, stop the processes the guest is running, flush the
 * workspace filesystem, exit 0.
 *
 * **What this suite can and cannot see.** It spawns the agent as an
 * ordinary child process, so it is not pid 1 of anything and the quiesce it
 * runs narrows itself to the kernel sessions its own registries own — which
 * is the scope that covers an `exec`'s child, the one asserted below. What
 * no test on this machine can reach is the pathology the fix exists for: a
 * VM runtime class where the container was killed about a second into a
 * five-second stop, measured in #484 on a cluster this repo has no access
 * to. That is why the flush is performed by three independent paths (this
 * handler, the pod's `preStop` hook, and the host's own `flush()` before it
 * patches a workspace to `Suspended`) and why none of them is asserted here
 * as the one that works in production.
 *
 * The flush command is overridden in most cases below
 * (`NAMZU_AGENT_FLUSH_COMMAND`) so that a marker file can stand in for a
 * `syncfs` nothing here can observe. One case leaves it alone and shims
 * `sync` on PATH instead, which is what proves the DEFAULT is
 * `sync -f <workspace>` rather than whatever a test happened to pass.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type AddressInfo, connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { decodeFrames, encodeFrame, sendFramedRequest } from './fixtures/framed-agent-client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT_ENTRY = join(HERE, '../../../../agent/agent.cjs')
const IS_WINDOWS = process.platform === 'win32'
const TOKEN = 'e7c1d9a2-0b64-4f2d-9d0e-4a3b6c5d8e91'

let workDir: string
let flushPidFile: string
let child: ChildProcess | undefined
let agentPort = 0

/** A port nothing is listening on yet, for an agent this process will start. */
async function freePort(): Promise<number> {
	const probe = createServer()
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
	const { port } = probe.address() as AddressInfo
	await new Promise<void>((resolve) => probe.close(() => resolve()))
	return port
}

/**
 * Start the real agent on loopback and wait until it answers `healthz`.
 *
 * `advertisesFlush` is asserted on that first reply rather than left to the
 * cases, because every case below depends on it: a guest that did not
 * advertise the feature would also not run the flush they are watching for,
 * and the assertion turns that into one clear failure instead of several
 * confusing ones.
 */
async function startAgent(
	env: Record<string, string> = {},
	{ advertisesFlush = true }: { advertisesFlush?: boolean } = {},
): Promise<ChildProcess> {
	agentPort = await freePort()
	const started = spawn(process.execPath, [AGENT_ENTRY], {
		env: {
			...process.env,
			NAMZU_AGENT_TCP_PORT: String(agentPort),
			NAMZU_AGENT_BIND_TOKEN: TOKEN,
			NAMZU_SANDBOX_WORKSPACE: workDir,
			...env,
		},
		stdio: ['ignore', 'ignore', 'pipe'],
	})
	child = started
	const deadline = Date.now() + 20_000
	for (;;) {
		try {
			const health = await sendFramedRequest(agentPort, { op: 'healthz' }, 2_000)
			if (health.reply.ok === true) {
				if (advertisesFlush) expect(health.reply.features).toContain('flush')
				else expect(health.reply.features).not.toContain('flush')
				return started
			}
		} catch {
			// Not listening yet.
		}
		if (Date.now() > deadline) throw new Error('the agent never came up')
		await delay(25)
	}
}

/** Resolves with how the agent process ended. */
function exitOf(process_: ChildProcess): Promise<{
	code: number | null
	signal: NodeJS.Signals | null
}> {
	return new Promise((resolve) => {
		process_.once('exit', (code, signal) => resolve({ code, signal }))
	})
}

/** Whether a connect to the agent's port is accepted right now. */
async function portAccepts(port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve) => {
		const socket = connect({ host: '127.0.0.1', port })
		socket.once('connect', () => {
			socket.destroy()
			resolve(true)
		})
		socket.once('error', () => resolve(false))
	})
}

/**
 * Send one request and leave the connection open — an `execute` that runs a
 * long command never answers until the command ends, and every case here is
 * about what happens to that command while it is still running.
 */
function startUnawaitedRequest(port: number, request: unknown): { close: () => void } {
	const socket = connect({ host: '127.0.0.1', port })
	socket.on('error', () => {
		// The agent going away mid-command is the point of these cases.
	})
	socket.on('connect', () => socket.write(encodeFrame(JSON.stringify(request))))
	return { close: () => socket.destroy() }
}

/**
 * A connection opened BEFORE the stop signal, asked something after it.
 *
 * `server.close()` stops the agent accepting new connections, so a socket
 * opened afterwards never reaches the dispatcher at all — and the refusal
 * gate the handler raises exists for precisely the caller that a close
 * cannot reach: one whose connection was already open. One question per
 * connection is enough, because every refusal here ends the socket.
 */
function openEarlyConnection(port: number): {
	ask: (request: unknown) => Promise<Record<string, unknown>>
	close: () => void
} {
	const socket = connect({ host: '127.0.0.1', port })
	socket.on('error', () => {
		// The agent going away underneath it is one of the outcomes.
	})
	const connected = new Promise<void>((resolve, reject) => {
		socket.once('connect', () => resolve())
		socket.once('error', reject)
	})
	return {
		ask: async (request: unknown) => {
			await connected
			return await new Promise<Record<string, unknown>>((resolve, reject) => {
				let buffered = Buffer.alloc(0)
				socket.on('data', (chunk: Buffer) => {
					buffered = Buffer.concat([buffered, chunk])
					const { frames } = decodeFrames(buffered)
					const first = frames[0]
					if (first !== undefined) resolve(JSON.parse(first) as Record<string, unknown>)
				})
				socket.once('close', () => reject(new Error('the agent answered nothing')))
				socket.write(encodeFrame(JSON.stringify(request)))
			})
		},
		close: () => socket.destroy(),
	}
}

/** Whether a pid is still a live process on this machine. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/**
 * Whether a pid is still RUNNING — a zombie is not, exactly as it is not in
 * `terminal-pty-slave.test.ts`'s `isAlive`. What is waited for below is that
 * a signal took effect, and a reparented pid sits as a zombie for only as
 * long as the init that inherited it takes to reap it.
 */
function pidRunning(pid: number): boolean {
	if (!pidAlive(pid)) return false
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
		return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
	} catch {
		// No `/proc` to read (macOS): `kill(pid, 0)` is all this can say.
		return true
	}
}

/**
 * A flush that blocks, and hands this test the pid doing the blocking.
 *
 * `NAMZU_AGENT_FLUSH_COMMAND` is run as `/bin/sh -c <command>` (see
 * `flushCommand()` in `agent/agent.cjs`), so `$$` is that shell's own pid —
 * and `exec` brings the sleeper up in its place instead of forking one, so
 * the pid written here is the one still running when the case ends. A bare
 * `sleep 600` is a process this test never learned the pid of: the agent's
 * exit at its own deadline reparents it to the machine's init, `afterEach`
 * knows only the agent and finds it already gone, and it goes on holding a
 * process for ten minutes after the suite has finished.
 */
function blockingFlush(seconds: number): string {
	return `echo $$ > ${flushPidFile}; exec sleep ${seconds}`
}

/**
 * Kill whatever a case's flush left blocking, and wait for it to actually go.
 *
 * Unasserted and bounded on purpose, the way `reapTrees` in
 * `terminal-pty-slave.test.ts` is: the budget exists so that a signal which
 * has not landed yet is not read as one that never will, and a loaded machine
 * must not turn the reaping into a red run. It runs whether or not the case
 * reached its end — an agent that exits at its deadline is exactly what a
 * failing case can leave behind too — and it reads the pid file here, before
 * `afterEach` removes the workspace the file lives in.
 */
async function reapFlush(): Promise<void> {
	if (!existsSync(flushPidFile)) return
	const pid = Number(readFileSync(flushPidFile, 'utf8').trim())
	if (!Number.isSafeInteger(pid) || pid <= 0 || !pidRunning(pid)) return
	try {
		process.kill(pid, 'SIGKILL')
	} catch {
		// It went between the check and the call.
	}
	const deadline = Date.now() + 1_000
	while (pidRunning(pid) && Date.now() < deadline) await delay(10)
}

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'k8s-agent-sigterm-'))
	// Inside the workspace, so it is fresh for every case and gone with it.
	flushPidFile = join(workDir, 'flush.pid')
})

afterEach(async () => {
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill('SIGKILL')
	}
	child = undefined
	await reapFlush()
	rmSync(workDir, { recursive: true, force: true })
})

describe.skipIf(IS_WINDOWS)('agent SIGTERM handling', () => {
	it('exits with a clean 0, not the default terminated-by-signal disposition', async () => {
		const marker = join(workDir, '..', `flushed-${Date.now()}`)
		const agent = await startAgent({ NAMZU_AGENT_FLUSH_COMMAND: `touch ${marker}` })
		const exited = exitOf(agent)

		const sentAt = Date.now()
		agent.kill('SIGTERM')
		const result = await Promise.race([
			exited,
			delay(10_000).then((): never => {
				throw new Error('agent did not exit within 10000ms of SIGTERM')
			}),
		])

		// The regression this guards: an unhandled SIGTERM is `code: null,
		// signal: 'SIGTERM'` (killed by the signal), not a clean exit.
		expect(result).toEqual({ code: 0, signal: null })
		expect(Date.now() - sentAt).toBeLessThan(10_000)
		// And the flush ran BEFORE the process was gone, which is the whole
		// point of handling the signal at all rather than letting it kill.
		expect(existsSync(marker)).toBe(true)
		rmSync(marker, { force: true })
	}, 40_000)

	it('flushes the workspace mount with syncfs by default, naming that mount', async () => {
		// No NAMZU_AGENT_FLUSH_COMMAND here: this is the one case that
		// asserts what the agent runs when nobody told it what to run.
		const shimDir = mkdtempSync(join(tmpdir(), 'k8s-sync-shim-'))
		const log = join(shimDir, 'log.txt')
		writeFileSync(join(shimDir, 'sync'), `#!/bin/sh\necho "sync $*" >> ${log}\n`)
		chmodSync(join(shimDir, 'sync'), 0o755)
		try {
			const agent = await startAgent({ PATH: `${shimDir}:${process.env.PATH ?? ''}` })
			const exited = exitOf(agent)
			agent.kill('SIGTERM')
			expect(await exited).toEqual({ code: 0, signal: null })
			// `sync -f PATH` is syncfs(2) on the filesystem holding PATH. A
			// bare `sync` would be every mounted filesystem on the node.
			expect(readFileSync(log, 'utf8').trim()).toBe(`sync -f ${workDir}`)
		} finally {
			rmSync(shimDir, { recursive: true, force: true })
		}
	}, 40_000)

	it('stops the command it is running, and flushes after it has stopped', async () => {
		const marker = join(workDir, '..', `flushed-order-${Date.now()}`)
		const agent = await startAgent({ NAMZU_AGENT_FLUSH_COMMAND: `touch ${marker}` })
		const pidFile = join(workDir, 'child.pid')
		// Reserved first, exactly as the host transport does it: an execution
		// the agent is TRACKING is the one its registries own, and the scope
		// this suite's agent narrows itself to (see the header) is the
		// sessions those registries hold. A pod, where the agent is started
		// by its namespace's init, scans `/proc` instead and needs no
		// reservation to find the same process.
		const reserved = await sendFramedRequest(agentPort, {
			op: 'reserve-execution',
			token: TOKEN,
			body: {},
		})
		expect(reserved.reply.ok).toBe(true)
		const executionId = String(reserved.reply.executionId)
		const request = startUnawaitedRequest(agentPort, {
			op: 'execute',
			token: TOKEN,
			body: {
				executionId,
				command: '/bin/sh',
				args: ['-c', `echo $$ > ${pidFile}; exec sleep 120`],
				timeoutMs: 120_000,
			},
		})
		// Wait for the command to actually be running, so the case is about a
		// live process rather than about a race with `spawn`.
		const deadline = Date.now() + 10_000
		while (!existsSync(pidFile) && Date.now() < deadline) await delay(25)
		const pid = Number(readFileSync(pidFile, 'utf8').trim())
		expect(pidAlive(pid)).toBe(true)

		const exited = exitOf(agent)
		agent.kill('SIGTERM')
		expect(await exited).toEqual({ code: 0, signal: null })
		request.close()

		// The process the agent owned is gone, and the flush happened. A
		// handler that flushed while a compiler was still writing would have
		// flushed the wrong moment.
		expect(pidAlive(pid)).toBe(false)
		expect(existsSync(marker)).toBe(true)
		rmSync(marker, { force: true })
	}, 60_000)

	it('stops accepting connections before it stops anything', async () => {
		// A flush slow enough that the assertion below lands while the
		// handler is still inside it.
		const agent = await startAgent({ NAMZU_AGENT_FLUSH_COMMAND: 'sleep 3' })
		expect(await portAccepts(agentPort)).toBe(true)
		const exited = exitOf(agent)
		agent.kill('SIGTERM')
		// Long enough for the handler to have run its first statement, short
		// enough that the 3s flush is still in flight.
		await delay(400)
		expect(await portAccepts(agentPort)).toBe(false)
		expect(await exited).toEqual({ code: 0, signal: null })
	}, 40_000)

	it('exits at its own deadline even when the flush will not finish', async () => {
		const agent = await startAgent({
			NAMZU_AGENT_FLUSH_COMMAND: blockingFlush(600),
			NAMZU_AGENT_SHUTDOWN_DEADLINE_MS: '1500',
			NAMZU_AGENT_FLUSH_TIMEOUT_MS: '600000',
		})
		const exited = exitOf(agent)
		const sentAt = Date.now()
		agent.kill('SIGTERM')
		const result = await Promise.race([
			exited,
			delay(20_000).then((): never => {
				throw new Error('the handler never expired its own bound')
			}),
		])
		const elapsedMs = Date.now() - sentAt
		// The bound is not optional: a handler that waited on a flush that
		// never finishes would hold the pod open until the kubelet's SIGKILL,
		// which is the behaviour it exists to replace.
		expect(result).toEqual({ code: 0, signal: null })
		expect(elapsedMs).toBeGreaterThanOrEqual(1_000)
		expect(elapsedMs).toBeLessThan(15_000)
	}, 40_000)

	it('does not advertise a flush it has no program to run', async () => {
		// `k8s/Dockerfile` says in so many words that a derived image which
		// strips coreutils is a real shape, and such an image has all of
		// this code and no `sync`. Advertising the feature there would
		// refuse that workspace's every default `suspend()` for the life of
		// the pod — permanently, since nothing about that guest changes —
		// which is the exact failure the feature list exists to prevent.
		const emptyDir = mkdtempSync(join(tmpdir(), 'k8s-no-sync-'))
		try {
			await startAgent({ PATH: emptyDir }, { advertisesFlush: false })
			const health = await sendFramedRequest(agentPort, { op: 'healthz' }, 2_000)
			// The rest of the list is untouched: this is one feature going
			// missing on one image, not a degraded agent.
			expect(health.reply.features).toContain('quiesce')
			expect(health.reply.features).not.toContain('flush')

			// And asked for one anyway, it answers in the shape a host reads
			// as "this image cannot flush" — not as a flush that ran and
			// could not be confirmed, which would stop every suspend.
			const flushed = await sendFramedRequest(
				agentPort,
				{ op: 'flush', token: TOKEN, body: {} },
				5_000,
			)
			expect(flushed.reply.ok).toBe(false)
			expect(flushed.reply.error).toBe('flush_unsupported')
		} finally {
			rmSync(emptyDir, { recursive: true, force: true })
		}
	}, 40_000)

	it('does not let a second stop signal cut its own bound short', async () => {
		// This handler used to exit 0 the moment a second SIGTERM arrived,
		// read as a host or an operator saying "stop waiting". In the pod it
		// runs in, the second signal is nobody's instruction: `entrypoint.sh
		// prestop` signals pid 1 and waits, and the kubelet sends its OWN
		// stop signal as soon as that hook returns. So the immediate exit
		// capped this drain at whatever the hook had waited — on exactly
		// the slow flush the handler exists for — and exited 0 over the
		// truncation, which is the exit code #484's acceptance criteria read
		// as a clean stop. The bound is the deadline and nothing else.
		const agent = await startAgent({
			NAMZU_AGENT_FLUSH_COMMAND: blockingFlush(600),
			NAMZU_AGENT_SHUTDOWN_DEADLINE_MS: '4000',
			NAMZU_AGENT_FLUSH_TIMEOUT_MS: '600000',
		})
		const exited = exitOf(agent)
		const sentAt = Date.now()
		agent.kill('SIGTERM')
		await delay(300)
		agent.kill('SIGTERM')
		// A second after the signal that used to end it, it is still
		// draining.
		await delay(1_000)
		expect(agent.exitCode).toBeNull()

		const result = await Promise.race([
			exited,
			delay(20_000).then((): never => {
				throw new Error('the handler never expired its own bound')
			}),
		])
		// And it ends at its own deadline, the way it does with no second
		// signal at all.
		expect(result).toEqual({ code: 0, signal: null })
		expect(Date.now() - sentAt).toBeGreaterThanOrEqual(3_500)
		expect(Date.now() - sentAt).toBeLessThan(15_000)
	}, 40_000)

	it('keeps its refusal gate up when a quiesce that was in flight finishes', async () => {
		// The handler raises the same gate an explicit `quiesce` raises, and
		// `handleQuiesce`'s own `finally` used to lower it unconditionally.
		// So a quiesce that was still running when the stop signal arrived
		// lowered a gate it had not raised, and the connection that was
		// already open got the right to start a command in a guest whose pod
		// is going away — against a comment that says the gate is never
		// lowered again.
		const agent = await startAgent({
			NAMZU_AGENT_FLUSH_COMMAND: 'sleep 8',
			NAMZU_AGENT_SHUTDOWN_DEADLINE_MS: '20000',
			NAMZU_AGENT_FLUSH_TIMEOUT_MS: '20000',
		})
		// Something for the quiesce to spend real time on: a child that
		// ignores SIGTERM, so the op waits out the grace it was given before
		// it escalates. Without it the quiesce would answer in the same tick
		// and there would be no "in flight" to signal into.
		const reserved = await sendFramedRequest(agentPort, {
			op: 'reserve-execution',
			token: TOKEN,
			body: {},
		})
		expect(reserved.reply.ok).toBe(true)
		const running = startUnawaitedRequest(agentPort, {
			op: 'execute',
			token: TOKEN,
			body: {
				executionId: String(reserved.reply.executionId),
				command: '/bin/sh',
				args: ['-c', 'trap "" TERM; exec sleep 120'],
				timeoutMs: 120_000,
			},
		})
		await delay(500)

		const early = openEarlyConnection(agentPort)
		const quiesced = sendFramedRequest(
			agentPort,
			{ op: 'quiesce', token: TOKEN, body: { graceMs: 1_500 } },
			20_000,
		)
		await delay(200)
		const exited = exitOf(agent)
		agent.kill('SIGTERM')

		// The in-flight quiesce runs its `finally` here, inside the
		// handler's own drain-and-flush.
		await quiesced
		const refused = await early.ask({ op: 'reserve-execution', token: TOKEN, body: {} })
		expect(refused).toMatchObject({ ok: false, error: 'quiesce_in_progress' })

		early.close()
		running.close()
		expect(await exited).toEqual({ code: 0, signal: null })
	}, 60_000)
})
