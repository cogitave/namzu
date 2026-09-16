/**
 * The guest agent must exit promptly on SIGTERM.
 *
 * `packages/sandbox/k8s/entrypoint.sh` `exec`s straight into the agent — no
 * init, no shell left waiting — so in a real pod the agent process IS pid 1
 * of the container's own pid namespace. Linux leaves a signal whose default
 * action is "terminate" un-applied for pid 1 unless the process installs its
 * own handler for it; a kind smoke run confirmed exactly that gap: an
 * unhandled SIGTERM did nothing, and the pod rode out the full
 * `terminationGracePeriodSeconds` before SIGKILL finally landed.
 *
 * This suite cannot reproduce the pid-1-in-its-own-namespace kernel
 * behaviour itself — that needs a real container, not a spawned child, and
 * a plain child process is not pid 1 of anything. What it CAN assert, and
 * does, is the one thing the fix actually changed: an ordinary Node process
 * with no handler for a signal is *terminated BY* that signal — Node
 * reports `signal: 'SIGTERM', code: null` on exit, never a clean `exit(0)`.
 * Asserting `code === 0, signal === null` here is a real regression guard
 * for "the handler exists and calls `process.exit(0)`" — every other way
 * this could regress (the handler removed, or replaced by one that never
 * calls `exit`) fails this exact assertion, not a tautology every spawned
 * Node process would already satisfy.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { localIpcPath } from '../../firecracker/__tests__/fixtures/ipc-path.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT_ENTRY = join(HERE, '../../../../agent/agent.cjs')

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

let workDir: string
let child: ChildProcess | undefined

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'k8s-agent-sigterm-'))
})

afterEach(() => {
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill('SIGKILL')
	}
	child = undefined
	rmSync(workDir, { recursive: true, force: true })
})

describe('agent SIGTERM handling', () => {
	it('exits with a clean 0, not the default terminated-by-signal disposition', async () => {
		const sockPath = localIpcPath(workDir)
		child = spawn(process.execPath, [AGENT_ENTRY], {
			env: {
				...process.env,
				NAMZU_AGENT_UNIX_PATH: sockPath,
				NAMZU_SANDBOX_WORKSPACE: workDir,
			},
			stdio: ['ignore', 'ignore', 'ignore'],
		})
		const spawned = child

		await waitForListener(sockPath)

		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(resolve) => {
				spawned.once('exit', (code, signal) => resolve({ code, signal }))
			},
		)

		const sentAt = Date.now()
		spawned.kill('SIGTERM')

		const result = await Promise.race([
			exited,
			delay(3000).then((): never => {
				throw new Error('agent did not exit within 3000ms of SIGTERM')
			}),
		])
		const elapsedMs = Date.now() - sentAt

		// The regression this guards: an unhandled SIGTERM is `code: null,
		// signal: 'SIGTERM'` (killed by the signal), not a clean exit.
		expect(result).toEqual({ code: 0, signal: null })
		expect(elapsedMs).toBeLessThan(3000)
	})
})
