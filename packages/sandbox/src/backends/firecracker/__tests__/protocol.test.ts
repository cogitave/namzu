/**
 * Unit-pins the shared NDJSON codec the vsock + HTTP transports both
 * speak, and the `pickBackend` routing for `microvm:self-hosted`.
 */

import { describe, expect, it, vi } from 'vitest'

import { SandboxBackendNotImplementedError, createSandboxProvider } from '../../../index.js'
import { ExecResultAccumulator, parseExecLine } from '../protocol.js'

describe('ExecResultAccumulator', () => {
	it('accumulates stdout/stderr deltas and captures the terminal result', () => {
		const acc = new ExecResultAccumulator(0)
		expect(acc.push({ type: 'stdout_delta', data: 'a' })).toBe(false)
		expect(acc.push({ type: 'stdout_delta', data: 'b' })).toBe(false)
		expect(acc.push({ type: 'stderr_delta', data: 'E' })).toBe(false)
		expect(acc.done).toBe(false)
		expect(
			acc.push({
				type: 'result',
				exitCode: 0,
				timedOut: false,
				durationMs: 12,
				signal: 'SIGTERM',
				stdoutTruncated: true,
				stderrTruncated: false,
			}),
		).toBe(true)
		expect(acc.done).toBe(true)
		const r = acc.finish()
		expect(r.stdout).toBe('ab')
		expect(r.stderr).toBe('E')
		expect(r.exitCode).toBe(0)
		expect(r.timedOut).toBe(false)
		expect(r.durationMs).toBe(12)
		expect(r.signal).toBe('SIGTERM')
		expect(r.stdoutTruncated).toBe(true)
		expect(r.stderrTruncated).toBe(false)
		expect(() =>
			acc.push({ type: 'result', exitCode: 0, timedOut: false, durationMs: 13 }),
		).toThrow(/after its terminal event/)
	})

	it('throws on an error event (docker loop parity)', () => {
		const acc = new ExecResultAccumulator(0)
		expect(() => acc.push({ type: 'error', error: 'boom' })).toThrow('boom')
	})
})

describe('parseExecLine', () => {
	it('parses a valid NDJSON line', () => {
		expect(parseExecLine('{"type":"stdout_delta","data":"x"}')).toEqual({
			type: 'stdout_delta',
			data: 'x',
		})
	})
	it('ignores blank lines but rejects malformed or structurally invalid events', () => {
		expect(parseExecLine('')).toBeUndefined()
		expect(parseExecLine('   ')).toBeUndefined()
		expect(() => parseExecLine('{not json')).toThrow(/malformed NDJSON/)
		expect(() => parseExecLine('{"type":"result","exitCode":0}')).toThrow(/invalid result/)
	})
})

describe('pickBackend — microvm:self-hosted', () => {
	it('builds the firecracker backend when orchestratorEndpoint + getToken are present', () => {
		const provider = createSandboxProvider({
			backend: {
				tier: 'microvm',
				service: 'self-hosted',
				orchestratorEndpoint: 'https://orchestrator.test',
				getToken: async () => 'tok',
				template: 'golden-rev-1',
			},
		})
		expect(provider.id).toContain('microvm')
		expect(provider.id).toContain('firecracker')
		expect(provider.name).toContain('microvm:self-hosted')
	})

	it('refuses the shape that reaches no orchestrator', () => {
		// The control-plane endpoint and its bearer are required now. They
		// used to be optional beside three REQUIRED fields belonging to a
		// local-daemon path that was never written, so the only working
		// configuration had to supply three values nothing reads — and
		// omitting these two type-checked its way to a runtime throw.
		expect(() =>
			createSandboxProvider({
				backend: { tier: 'microvm', service: 'self-hosted' },
			} as never),
		).toThrow(SandboxBackendNotImplementedError)
	})

	it('forwards per-create cancellation through the public provider factory', async () => {
		const getToken = vi.fn(async () => 'tok')
		const provider = createSandboxProvider({
			backend: {
				tier: 'microvm',
				service: 'self-hosted',
				orchestratorEndpoint: 'https://orchestrator.test',
				getToken,
			},
		})
		const caller = new AbortController()
		const reason = new Error('allocation authority withdrawn')
		caller.abort(reason)

		await expect(provider.create({ signal: caller.signal })).rejects.toBe(reason)
		expect(getToken).not.toHaveBeenCalled()
	})
})
