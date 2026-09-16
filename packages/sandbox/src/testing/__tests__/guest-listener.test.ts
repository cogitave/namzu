/**
 * `startGuestListener` and `nodeGuestListener`, in isolation from any real
 * `Sandbox` — the piece of `sandbox-conformance.ts`'s `openTcpConnection`
 * positive case that starts a listener INSIDE the guest through
 * `openTerminal`, reads its port back from whatever it printed, and tears
 * it down again.
 *
 * The two real conformance suites (`backends/kubernetes/__tests__/conformance.test.ts`,
 * `backends/firecracker/__tests__/conformance.test.ts`) already prove this
 * works end to end against a real `agent/agent.cjs`. What they cannot show
 * on their own is that the helper behaves for the shapes a pty actually
 * delivers — a report split across chunks, a listener that never reports a
 * port at all — so this file drives it directly against a fake
 * `TerminalSession`, the same way `conformance-fails-a-broken-sandbox.test.ts`
 * drives the whole suite against a fake `Sandbox`.
 */

import type { OpenTerminalOptions, TerminalSession } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { nodeGuestListener, startGuestListener } from '../sandbox-conformance.js'

/**
 * A `TerminalSession` this file drives by hand: no real process anywhere.
 *
 * `subscribed` resolves once `startGuestListener` has registered its
 * `onData` listener. `openTerminal` — and, through it, everything
 * `startGuestListener` does before that registration — is async, so a test
 * that called `emit` right after starting would race it and lose the
 * chunk; awaiting `subscribed` first makes the handoff deterministic
 * without hard-coding how many microtask hops sit in between.
 */
function fakeTerminal(): {
	readonly session: TerminalSession
	readonly killSignals: (string | undefined)[]
	readonly subscribed: Promise<void>
	emit(chunk: string): void
	exit(result: { exitCode: number; signal?: number }): void
} {
	const listeners = new Set<(chunk: string) => void>()
	const killSignals: (string | undefined)[] = []
	let resolveExited!: (result: { exitCode: number; signal?: number }) => void
	const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
		resolveExited = resolve
	})
	let resolveSubscribed!: () => void
	const subscribed = new Promise<void>((resolve) => {
		resolveSubscribed = resolve
	})

	const session: TerminalSession = {
		write: () => {},
		resize: () => {},
		onData(listener) {
			listeners.add(listener)
			resolveSubscribed()
			return () => listeners.delete(listener)
		},
		exited,
		kill(signal) {
			killSignals.push(signal)
		},
	}

	return {
		session,
		killSignals,
		subscribed,
		emit: (chunk) => {
			for (const listener of listeners) listener(chunk)
		},
		exit: (result) => resolveExited(result),
	}
}

describe('nodeGuestListener', () => {
	it('reports no port until its marker has printed one', () => {
		const listener = nodeGuestListener()
		expect(listener.parsePort('')).toBeUndefined()
		expect(listener.parsePort('node is booting up...\n')).toBeUndefined()
	})

	it('parses the port once the marker line is complete', () => {
		const listener = nodeGuestListener()
		expect(listener.parsePort('namzu-conformance-listening:41234\n')).toBe(41234)
	})

	it('parses the port even when the marker arrives split across chunks', () => {
		const listener = nodeGuestListener()
		// The suite feeds `parsePort` the ACCUMULATED output on every chunk,
		// never a single chunk alone — this is what that accumulation looks
		// like one step before the marker is complete, and one step after.
		expect(listener.parsePort('booting...\nnamzu-conformance-liste')).toBeUndefined()
		expect(listener.parsePort('booting...\nnamzu-conformance-listening:9001\n')).toBe(9001)
	})
})

describe('startGuestListener', () => {
	it('resolves with the port once the listener reports it, split across chunks', async () => {
		const fake = fakeTerminal()
		const openTerminal = async (_options: OpenTerminalOptions) => fake.session

		const started = startGuestListener(openTerminal, nodeGuestListener())
		await fake.subscribed
		fake.emit('namzu-conformance-listening:')
		fake.emit('54321\n')

		const listener = await started
		expect(listener.port).toBe(54321)
	})

	it('passes the listener command through to openTerminal verbatim', async () => {
		const fake = fakeTerminal()
		const seen: OpenTerminalOptions[] = []
		const openTerminal = async (options: OpenTerminalOptions) => {
			seen.push(options)
			return fake.session
		}
		const command = nodeGuestListener()

		const started = startGuestListener(openTerminal, command)
		await fake.subscribed
		fake.emit('namzu-conformance-listening:1\n')
		await started

		expect(seen.length).toBe(1)
		expect(seen[0]?.command).toBe(command.command)
		expect(seen[0]?.args).toEqual(command.args)
	})

	it('stop() kills the terminal and awaits its exit', async () => {
		const fake = fakeTerminal()
		const openTerminal = async () => fake.session

		const promise = startGuestListener(openTerminal, nodeGuestListener())
		await fake.subscribed
		fake.emit('namzu-conformance-listening:9999\n')
		const started = await promise

		expect(fake.killSignals.length).toBe(0)
		const stopped = started.stop()
		expect(fake.killSignals.length).toBe(1)
		fake.exit({ exitCode: 0, signal: 15 })
		await stopped
	})

	it('rejects, naming the exit code, when the listener exits before ever reporting a port', async () => {
		const fake = fakeTerminal()
		const openTerminal = async () => fake.session

		const started = startGuestListener(openTerminal, nodeGuestListener())
		fake.emit('some startup noise with no marker in it\n')
		fake.exit({ exitCode: 7 })

		await expect(started).rejects.toThrow(/exited before reporting a port \(exit code 7\)/)
	})
})
