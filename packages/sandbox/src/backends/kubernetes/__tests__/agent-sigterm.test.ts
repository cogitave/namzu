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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
	// The port is chosen by binding 0 and closing, so another test file
	// running in parallel can take it before this agent listens. The agent
	// then exits (address in use), or a probe reaches a listener that is not
	// the agent at all. Both are detected, and the start is retried on a
	// fresh port, a bounded number of TIMES (never of seconds).
	const attempts = 5
	for (let attempt = 1; ; attempt += 1) {
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
		// No wall-clock deadline: the agent either answers or exits. One that
		// neither answers nor exits is a hang the case's own Vitest timeout
		// reports (the cases below raise it: this is a real child process on
		// a possibly loaded machine).
		let exitedEarly = false
		started.once('exit', () => {
			exitedEarly = true
		})
		let foreign = false
		for (;;) {
			try {
				const health = await sendFramedRequest(agentPort, { op: 'healthz' }, 2_000)
				if (health.reply.ok === true && !exitedEarly) {
					if (advertisesFlush) expect(health.reply.features).toContain('flush')
					else expect(health.reply.features).not.toContain('flush')
					return started
				}
			} catch (error) {
				// Not listening yet, or something that is not the agent.
				if (String((error as Error).message).includes('not speaking the agent protocol')) {
					foreign = true
				}
			}
			if (exitedEarly || foreign) break
			await delay(25)
		}
		if (started.exitCode === null && started.signalCode === null) started.kill('SIGKILL')
		if (attempt >= attempts) {
			throw new Error(
				foreign
					? `port ${agentPort} was answered by something that is not the agent, ${attempts} times running`
					: `the agent exited before it came up, ${attempts} times running`,
			)
		}
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

/**
 * Wait for a file the case's own child writes, and return its trimmed text.
 * Awaits the event (the file appearing, with its content) rather than
 * sleeping for a guessed time; a file that never appears is a hang the
 * case's Vitest timeout reports, and `timeout` here only has to outlast
 * the slowest honest machine.
 */
async function fileText(path: string): Promise<string> {
	return await vi.waitFor(
		() => {
			const text = existsSync(path) ? readFileSync(path, 'utf8').trim() : ''
			if (text === '') throw new Error(`${path} has not been written yet`)
			return text
		},
		{ timeout: 30_000, interval: 25 },
	)
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

/**
 * Every case starts a real agent child process (and several wait out its
 * deadlines), and a CI runner under load has been seen to take most of a
 * minute for one of them. There is no readiness event the agent emits, so
 * the start polls `healthz` with no deadline of its own; this is the one
 * bound, and it is generous because it only ever fires on a genuine hang.
 */
const CASE_TIMEOUT_MS = 180_000

describe.skipIf(IS_WINDOWS)('agent SIGTERM handling', () => {
	it(
		'exits with a clean 0, not the default terminated-by-signal disposition',
		async () => {
			const marker = join(workDir, '..', `flushed-${Date.now()}`)
			const agent = await startAgent({ NAMZU_AGENT_FLUSH_COMMAND: `touch ${marker}` })
			const exited = exitOf(agent)

			agent.kill('SIGTERM')
			// Awaited outright: an agent that never exits is a hang the case's
			// own Vitest timeout reports, so no sentinel races it.
			const result = await exited

			// The regression this guards: an unhandled SIGTERM is `code: null,
			// signal: 'SIGTERM'` (killed by the signal), not a clean exit.
			expect(result).toEqual({ code: 0, signal: null })
			// And the flush ran BEFORE the process was gone, which is the whole
			// point of handling the signal at all rather than letting it kill.
			expect(existsSync(marker)).toBe(true)
			rmSync(marker, { force: true })
		},
		CASE_TIMEOUT_MS,
	)

	it(
		'flushes the workspace mount with syncfs by default, naming that mount',
		async () => {
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
		},
		CASE_TIMEOUT_MS,
	)

	it(
		'stops the command it is running, and flushes after it has stopped',
		async () => {
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
			const pid = Number(await fileText(pidFile))
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
		},
		CASE_TIMEOUT_MS,
	)

	it(
		'stops accepting connections before it stops anything',
		async () => {
			// A flush slow enough that the assertion below lands while the
			// handler is still inside it.
			const agent = await startAgent({ NAMZU_AGENT_FLUSH_COMMAND: blockingFlush(600) })
			expect(await portAccepts(agentPort)).toBe(true)
			const exited = exitOf(agent)
			let ended = false
			void exited.then(() => {
				ended = true
			})
			agent.kill('SIGTERM')
			// Wait for the flush to be RUNNING, which is the event "the handler
			// has got past its first statements and is inside the flush". It
			// blocks for as long as the case lets it, so there is no moment at
			// which the flush could have finished and made the assertion below
			// about a handler that is already done.
			await fileText(flushPidFile)
			expect(ended).toBe(false)
			expect(await portAccepts(agentPort)).toBe(false)
			// Release the flush; the agent then ends on its own.
			process.kill(Number(await fileText(flushPidFile)), 'SIGKILL')
			expect(await exited).toEqual({ code: 0, signal: null })
		},
		CASE_TIMEOUT_MS,
	)

	it(
		'exits at its own deadline even when the flush will not finish',
		async () => {
			const agent = await startAgent({
				NAMZU_AGENT_FLUSH_COMMAND: blockingFlush(600),
				NAMZU_AGENT_SHUTDOWN_DEADLINE_MS: '1500',
				NAMZU_AGENT_FLUSH_TIMEOUT_MS: '600000',
			})
			const exited = exitOf(agent)
			const sentAt = Date.now()
			agent.kill('SIGTERM')
			// The bound is not optional: a handler that waited on a flush that
			// never finishes would hold the pod open until the kubelet's SIGKILL,
			// which is the behaviour it exists to replace. That shows here as an
			// exit that never comes, which the case's Vitest timeout reports; no
			// upper bound on elapsed time is asserted, since how long a loaded
			// machine takes to deliver the exit is not the product's promise.
			const result = await exited
			const elapsedMs = Date.now() - sentAt
			expect(result).toEqual({ code: 0, signal: null })
			// The lower bound cannot be tripped by a slow machine: the flush is
			// still blocking (600s) at that point, so an exit before the
			// deadline is the handler giving up early.
			expect(elapsedMs).toBeGreaterThanOrEqual(1_000)
		},
		CASE_TIMEOUT_MS,
	)

	it(
		'does not advertise a flush it has no program to run',
		async () => {
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
		},
		CASE_TIMEOUT_MS,
	)

	it(
		'does not let a second stop signal cut its own bound short',
		async () => {
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
			// The second signal goes out only once the first has been handled
			// (its flush is running), so the two cannot be coalesced into one
			// delivery and the second really lands on a handler that is draining.
			await fileText(flushPidFile)
			agent.kill('SIGTERM')

			// Awaited outright, no sentinel: a handler that never expires its own
			// bound is a hang the case's Vitest timeout reports.
			const result = await exited
			// And it ends at its own deadline, the way it does with no second
			// signal at all. The lower bound is what the old behaviour broke (an
			// exit as soon as the second signal landed), and a slow machine
			// cannot trip it, because the flush is still blocking at that point.
			expect(result).toEqual({ code: 0, signal: null })
			expect(Date.now() - sentAt).toBeGreaterThanOrEqual(3_500)
		},
		CASE_TIMEOUT_MS,
	)

	it(
		'keeps its refusal gate up when a quiesce that was in flight finishes',
		async () => {
			// The handler raises the same gate an explicit `quiesce` raises, and
			// `handleQuiesce`'s own `finally` used to lower it unconditionally.
			// So a quiesce that was still running when the stop signal arrived
			// lowered a gate it had not raised, and the connection that was
			// already open got the right to start a command in a guest whose pod
			// is going away — against a comment that says the gate is never
			// lowered again.
			const runningFile = join(workDir, 'running.pid')
			const termedFile = join(workDir, 'termed.txt')
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
					// Writes its pid when it is running and a marker for every
					// TERM it is sent, and never exits on one: it holds the
					// quiesce inside its grace, and tells the case when that
					// quiesce has begun signalling.
					args: [
						'-c',
						`echo $$ > ${runningFile}; trap 'echo t >> ${termedFile}' TERM; while :; do sleep 1; done`,
					],
					timeoutMs: 120_000,
				},
			})
			// The command is running once it has said so.
			await fileText(runningFile)

			const early = openEarlyConnection(agentPort)
			const quiesced = sendFramedRequest(
				agentPort,
				{ op: 'quiesce', token: TOKEN, body: { graceMs: 3_000 } },
				20_000,
			)
			// The quiesce is in flight once it has sent the command its first
			// TERM, and it stays in flight for its whole grace after that.
			await fileText(termedFile)
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
		},
		CASE_TIMEOUT_MS,
	)
})
