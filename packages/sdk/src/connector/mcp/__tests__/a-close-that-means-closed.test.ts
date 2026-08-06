import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { StdioTransport } from '../stdio.js'

/**
 * `close()` sent SIGTERM and returned without waiting, so a resolved close
 * meant "the signal is on its way", not "the child is gone". A caller that
 * closed a transport and then deleted the child's working directory raced the
 * exit and saw EBUSY — reported from a real integration, not inferred.
 *
 * A close that does not mean closed makes every teardown built on top of it a
 * guess, and the guess is only wrong sometimes, which is the worst kind.
 *
 * These assert on the operating system rather than on the transport's own
 * state: `process.kill(pid, 0)` throws ESRCH once the pid is gone, so the
 * assertion cannot pass by the transport merely believing it closed.
 */

/** The child the transport spawned, read before `close()` clears the field. */
function childOf(transport: StdioTransport): ChildProcess {
	const child = (transport as unknown as { process: ChildProcess | null }).process
	if (!child) throw new Error('transport spawned no process')
	return child
}

function pidOf(transport: StdioTransport): number {
	const pid = childOf(transport).pid
	if (pid === undefined) throw new Error('transport spawned no process')
	return pid
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

describe('a close that means closed', () => {
	it('does not resolve until the child is actually gone', async () => {
		const transport = new StdioTransport({
			type: 'stdio',
			command: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
		})
		await transport.connect()
		const child = childOf(transport)
		const pid = pidOf(transport)
		expect(isAlive(pid)).toBe(true)

		await transport.close()

		// The reaped-ness of the child, not the liveness of the pid.
		//
		// `isAlive(pid)` alone is sound about the wrong thing: on Windows
		// `kill('SIGTERM')` terminates the process synchronously, so the pid is
		// already gone by the next line whether or not `close()` waited — the
		// assertion passed under a deliberately reintroduced fire-and-forget
		// kill, which is how this was caught. Node fills `exitCode`/`signalCode`
		// only when it reaps the child and emits `exit`, a later tick, so these
		// are non-null here exactly when `close()` awaited that event.
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
		expect(isAlive(pid)).toBe(false)
	})

	it('returns rather than hanging when the command does not exist', async () => {
		// A spawn that fails emits `error` and never `exit`. Waiting on `exit`
		// alone would turn a bad command into a shutdown that never completes.
		const transport = new StdioTransport({
			type: 'stdio',
			command: 'namzu-no-such-command-exists-here',
			args: [],
		})
		await transport.connect()

		await expect(transport.close()).resolves.toBeUndefined()
	})

	it('is safe to call twice', async () => {
		const transport = new StdioTransport({
			type: 'stdio',
			command: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
		})
		await transport.connect()
		const pid = pidOf(transport)

		await transport.close()
		await transport.close()

		expect(isAlive(pid)).toBe(false)
	})

	it('reports the exit to the handler registered for that session', async () => {
		// The waiting must not swallow the notification the client depends on
		// to learn the session ended.
		const transport = new StdioTransport({
			type: 'stdio',
			command: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
		})
		await transport.connect()
		let closes = 0
		transport.onClose(() => {
			closes++
		})

		await transport.close()
		// `close` on a ChildProcess follows `exit` by a tick once the stdio
		// streams drain; give the loop that tick rather than asserting on a
		// race.
		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(closes).toBe(1)
	})
})
