/**
 * Unit-pins the shared NDJSON codec the vsock + HTTP transports both
 * speak, and the `pickBackend` routing for `microvm:self-hosted`.
 */

import { describe, expect, it } from 'vitest'

import { SandboxBackendNotImplementedError, createSandboxProvider } from '../../../index.js'
import { ExecResultAccumulator, parseExecLine } from '../protocol.js'

describe('ExecResultAccumulator', () => {
	it('accumulates stdout/stderr deltas and captures the terminal result', () => {
		const acc = new ExecResultAccumulator(0)
		expect(acc.push({ type: 'stdout_delta', data: 'a' })).toBe(false)
		expect(acc.push({ type: 'stdout_delta', data: 'b' })).toBe(false)
		expect(acc.push({ type: 'stderr_delta', data: 'E' })).toBe(false)
		expect(acc.done).toBe(false)
		expect(acc.push({ type: 'result', exitCode: 0, timedOut: false })).toBe(true)
		expect(acc.done).toBe(true)
		const r = acc.finish()
		expect(r.stdout).toBe('ab')
		expect(r.stderr).toBe('E')
		expect(r.exitCode).toBe(0)
		expect(r.timedOut).toBe(false)
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
	it('returns undefined for blank or malformed lines (SyntaxError swallow)', () => {
		expect(parseExecLine('')).toBeUndefined()
		expect(parseExecLine('   ')).toBeUndefined()
		expect(parseExecLine('{not json')).toBeUndefined()
	})
})

describe('pickBackend — microvm:self-hosted', () => {
	it('builds the firecracker backend when orchestratorEndpoint + getToken are present', () => {
		const provider = createSandboxProvider({
			backend: {
				tier: 'microvm',
				service: 'self-hosted',
				firecrackerBinary: '/usr/bin/firecracker',
				kernelImage: '/golden/vmlinux',
				rootfsImage: '/golden/rootfs.ext4',
				orchestratorEndpoint: 'https://orchestrator.test',
				getToken: async () => 'tok',
				template: 'golden-rev-1',
			},
		})
		expect(provider.id).toContain('microvm')
		expect(provider.id).toContain('firecracker')
		expect(provider.name).toContain('microvm:self-hosted')
	})

	it('still throws for the legacy local-containerd self-hosted shape (no orchestrator)', () => {
		expect(() =>
			createSandboxProvider({
				backend: {
					tier: 'microvm',
					service: 'self-hosted',
					firecrackerBinary: '/usr/bin/firecracker',
					kernelImage: '/k',
					rootfsImage: '/r',
				},
			}),
		).toThrow(SandboxBackendNotImplementedError)
	})

	it('still throws for microvm:e2b and microvm:fly-machines', () => {
		expect(() =>
			createSandboxProvider({ backend: { tier: 'microvm', service: 'e2b', apiKey: 'k' } }),
		).toThrow(SandboxBackendNotImplementedError)
		expect(() =>
			createSandboxProvider({
				backend: { tier: 'microvm', service: 'fly-machines', apiToken: 't', app: 'a', image: 'i' },
			}),
		).toThrow(SandboxBackendNotImplementedError)
	})
})
