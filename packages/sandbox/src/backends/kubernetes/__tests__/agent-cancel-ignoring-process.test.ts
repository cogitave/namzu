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
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { localIpcPath } from '../../firecracker/__tests__/fixtures/ipc-path.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT_ENTRY = join(HERE, '../../../../agent/agent.cjs')
const LENGTH_PREFIX_HEX = 8

/** Encode one request frame exactly as `agent.cjs`'s own `frame()` does. */
function encodeFrame(payload: string): Buffer {
	const body = Buffer.from(payload, 'utf8')
	const header = Buffer.from(
		`${body.length.toString(16).padStart(LENGTH_PREFIX_HEX, '0')}\n`,
		'ascii',
	)
	return Buffer.concat([header, body])
}

/** Split a received buffer into whole frames; a zero-length frame is `''`. */
function decodeFrames(buffer: Buffer): { frames: string[]; rest: Buffer } {
	const frames: string[] = []
	let rest = buffer
	for (;;) {
		const newline = rest.indexOf(0x0a)
		if (newline < LENGTH_PREFIX_HEX) break
		const length = Number.parseInt(rest.subarray(0, newline).toString('ascii'), 16)
		const start = newline + 1
		if (rest.length < start + length) break
		frames.push(rest.subarray(start, start + length).toString('utf8'))
		rest = rest.subarray(start + length)
	}
	return { frames, rest }
}

/** Retries a connect until the agent's unix listener accepts one. */
async function waitForListener(sockPath: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs
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
		if (Date.now() > deadline) {
			throw new Error(`agent never listened on ${sockPath} within ${timeoutMs}ms`)
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
		await waitForListener(sockPath)

		const reserved = await request(sockPath, 'reserve-execution', {})
		const executionId = reserved[0]?.executionId as string
		expect(executionId).toMatch(/^exec_/)

		const marker = 'conformance-abort-marker.txt'
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
				// Identical fixture to
				// `testing/sandbox-conformance.ts`'s "honours an AbortSignal"
				// case: both the foreground shell and its backgrounded child
				// trap and ignore SIGTERM, and the child writes `marker` a
				// moment after the whole command is observably running.
				args: [
					'-c',
					`trap '' TERM; (trap '' TERM; sleep 0.4; printf late > ${marker}) & echo ready; wait`,
				],
			},
			(frame) => {
				if (frame.type === 'stdout_delta' && String(frame.data).includes('ready')) {
					sawReady?.()
				}
			},
		)
		await ready

		const abortedAt = Date.now()
		const cancelled = await request(sockPath, 'cancel-execution', { executionId })
		const cancelElapsedMs = Date.now() - abortedAt

		const execFrames = await execPromise
		const resultFrame = execFrames.find((f) => f.type === 'result' || f.type === 'error')

		// The decisive check, straight from the conformance suite's own
		// comment: if the process was genuinely killed on abort, the write
		// it schedules a moment later never happens.
		await delay(900)
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

		// Confirmation must land fast, not merely inside the host's whole
		// 8s `RemoteExecutionController` budget — the marker's own 400ms
		// natural-completion window is the real deadline this races.
		expect(cancelElapsedMs).toBeLessThan(400)
	}, 10_000)

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
		await waitForListener(sockPath)

		const execFrames = await request(sockPath, 'execute', {
			command: '/bin/sh',
			args: ['-c', 'printf ok'],
		})
		const resultFrame = execFrames.find((f) => f.type === 'result')
		expect(resultFrame).toMatchObject({ exitCode: 0 })
	})
})
