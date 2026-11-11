/**
 * Regression for issue #469's AbortSignal conformance failure on a real
 * kind cluster (see `research/k8s-sandbox/kind-e2e-results.md`'s "Why the
 * `AbortSignal` case fails here").
 *
 * `terminateAndConfirm` in `agent/agent.cjs` sends SIGTERM to the owned
 * process group, waits up to `NAMZU_AGENT_CANCEL_GRACE_MS` for the group to
 * go quiet, and only escalates to SIGKILL if it is still alive at the end
 * of that window. A command that traps and ignores SIGTERM but happens to
 * finish **on its own** before the grace window elapses therefore reads as
 * "the signal worked" — nothing ever checks that the exit was actually
 * caused by the signal — and the agent reports a clean, unaborted-looking
 * result, in direct violation of `SandboxExecOptions.signal`'s contract:
 * "a backend that accepts the signal must terminate the process it owns
 * ... it must never silently ignore the signal and let the command run to
 * completion while reporting as though it had been cancelled."
 *
 * This is not a transport or a cluster-timing artifact: it reproduces
 * byte-for-byte, deterministically, on a loopback `agent.cjs` process on
 * this machine, with no Kubernetes, kind, or microVM involved. Every OTHER
 * suite that drives this same path shortens `NAMZU_AGENT_CANCEL_GRACE_MS`
 * to 50ms "so the abort case proves the kill in milliseconds, not the
 * production window" (see `firecracker/__tests__/conformance.test.ts`'s own
 * comment on `makeSandbox`) — which happens to flip which side of the race
 * wins against the shared conformance fixture's ~400ms-to-finish ignoring
 * command, and so the PRODUCTION default was never exercised by any test.
 * This one deliberately leaves `NAMZU_AGENT_CANCEL_GRACE_MS` unset.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { localIpcPath } from '../../firecracker/__tests__/fixtures/ipc-path.js'
import { decodeFrames, encodeFrame } from './fixtures/framed-agent-client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT_ENTRY = join(HERE, '../../../../agent/agent.cjs')

/** Retries a connect until the agent's unix listener accepts one. */
async function waitForListener(sockPath: string, agent: ChildProcess): Promise<void> {
	// No wall-clock deadline: the agent either listens or exits. One that
	// exits before it listens is reported as that; one that does neither is a
	// hang the case's own Vitest timeout reports.
	for (;;) {
		const ok = await new Promise<boolean>((resolve) => {
			const socket = connect(sockPath)
			socket.once('connect', () => {
				socket.end()
				resolve(true)
			})
			socket.once('error', () => resolve(false))
		})
		if (ok) return
		if (agent.exitCode !== null || agent.signalCode !== null) {
			throw new Error(`the agent exited before it listened on ${sockPath}`)
		}
		await delay(25)
	}
}

/** One request/response(-stream) round trip; resolves every frame received before the agent closes. */
function request(
	sockPath: string,
	op: string,
	body: Record<string, unknown>,
	onFrame?: (frame: Record<string, unknown>) => void,
): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		const socket = connect(sockPath)
		// Annotated `Buffer`, not inferred from `Buffer.alloc(0)`: `decodeFrames`
		// returns a `subarray` over `ArrayBufferLike`, the widest of the buffer
		// types, which a `Buffer<ArrayBuffer>` inferred here could not accept.
		let rest: Buffer = Buffer.alloc(0)
		const frames: Record<string, unknown>[] = []
		socket.on('connect', () => socket.write(encodeFrame(JSON.stringify({ op, body }))))
		socket.on('data', (chunk: Buffer) => {
			const decoded = decodeFrames(rest.length === 0 ? chunk : Buffer.concat([rest, chunk]))
			rest = decoded.rest
			for (const raw of decoded.frames) {
				if (raw === '') {
					socket.end()
					continue
				}
				const parsed = JSON.parse(raw) as Record<string, unknown>
				frames.push(parsed)
				onFrame?.(parsed)
			}
		})
		socket.on('close', () => resolve(frames))
		socket.on('error', reject)
	})
}

/** Whether a pid is a RUNNING process; a zombie awaiting its reaper is not. */
function pidRunning(pid: number): boolean {
	try {
		process.kill(pid, 0)
	} catch {
		return false
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
		return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
	} catch {
		return true
	}
}

let workDir: string
let child: ChildProcess | undefined

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'k8s-agent-cancel-'))
})

afterEach(() => {
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill('SIGKILL')
	}
	child = undefined
	rmSync(workDir, { recursive: true, force: true })
})

describe('agent cancel-execution against a SIGTERM-ignoring process', () => {
	it('kills it before it can finish on its own, using the PRODUCTION default NAMZU_AGENT_CANCEL_GRACE_MS', async () => {
		const sockPath = localIpcPath(workDir)
		// Deliberately NOT set: this is the one thing every other suite
		// shortens, and the whole point of this test is the unshortened,
		// shipped default.
		child = spawn(process.execPath, [AGENT_ENTRY], {
			env: {
				...process.env,
				NAMZU_AGENT_UNIX_PATH: sockPath,
				NAMZU_SANDBOX_WORKSPACE: workDir,
			},
			stdio: ['ignore', 'ignore', 'ignore'],
		})
		await waitForListener(sockPath, child)

		const reserved = await request(sockPath, 'reserve-execution', {})
		const executionId = reserved[0]?.executionId as string
		expect(executionId).toMatch(/^exec_/)

		// The command's natural end is the TEST's to give, not the clock's:
		// the backgrounded child finishes (and writes `marker`) only once
		// `releaseFile` exists, and the case creates that file only after the
		// cancel has been answered. So the child cannot end on its own, at
		// any speed of machine, before the kill, and "the process was killed
		// rather than allowed to finish" is shown by it being dead when the
		// cancel is confirmed, never by how many milliseconds that took.
		const marker = 'conformance-abort-marker.txt'
		const releaseFile = join(workDir, 'release')
		const childPidFile = join(workDir, 'child.pid')
		let sawReady: (() => void) | undefined
		const ready = new Promise<void>((resolve) => {
			sawReady = resolve
		})
		const execPromise = request(
			sockPath,
			'execute',
			{
				executionId,
				command: '/bin/sh',
				// The shape of `testing/sandbox-conformance.ts`'s "honours an
				// AbortSignal" case: both the foreground shell and its
				// backgrounded child trap and ignore SIGTERM, and the child
				// writes `marker` when it finishes on its own. It records its
				// pid before the command is observably running.
				args: [
					'-c',
					`trap '' TERM; (trap '' TERM; while [ ! -f ${releaseFile} ]; do sleep 0.05; done; printf late > ${marker}) & echo $! > ${childPidFile}; echo ready; wait`,
				],
			},
			(frame) => {
				if (frame.type === 'stdout_delta' && String(frame.data).includes('ready')) {
					sawReady?.()
				}
			},
		)
		await ready

		const childPid = Number(readFileSync(childPidFile, 'utf8').trim())
		expect(childPid).toBeGreaterThan(0)
		expect(pidRunning(childPid)).toBe(true)

		// A cancel that never escalates past the ignored SIGTERM never
		// answers, because nothing releases the child: that is a hang the
		// case's own Vitest timeout reports.
		const cancelled = await request(sockPath, 'cancel-execution', { executionId })

		const execFrames = await execPromise
		const resultFrame = execFrames.find((f) => f.type === 'result' || f.type === 'error')

		// The decisive check: the cancel is confirmed only once the process
		// group is gone, so a child that was genuinely killed is dead now.
		// Releasing it afterwards writes nothing, because there is nobody
		// left to write.
		expect(pidRunning(childPid)).toBe(false)
		writeFileSync(releaseFile, '')
		expect(existsSync(join(workDir, marker))).toBe(false)

		// The weaker, second check: cancellation must not settle looking
		// like an ordinary, unaborted success.
		expect(cancelled[0]?.ok).toBe(true)
		expect(resultFrame).toBeDefined()
		const cleanUnabortedSuccess =
			resultFrame?.type === 'result' &&
			resultFrame.exitCode === 0 &&
			resultFrame.signal === undefined
		expect(cleanUnabortedSuccess).toBe(false)
	}, 30_000)

	it('still lets a process that exits cleanly well inside the grace window report its real result', async () => {
		const sockPath = localIpcPath(workDir)
		child = spawn(process.execPath, [AGENT_ENTRY], {
			env: {
				...process.env,
				NAMZU_AGENT_UNIX_PATH: sockPath,
				NAMZU_SANDBOX_WORKSPACE: workDir,
			},
			stdio: ['ignore', 'ignore', 'ignore'],
		})
		await waitForListener(sockPath, child)

		const execFrames = await request(sockPath, 'execute', {
			command: '/bin/sh',
			args: ['-c', 'printf ok'],
		})
		const resultFrame = execFrames.find((f) => f.type === 'result')
		expect(resultFrame).toMatchObject({ exitCode: 0 })
	})
})
