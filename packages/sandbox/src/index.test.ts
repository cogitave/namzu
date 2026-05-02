/**
 * Behavioural contract for `createSandboxProvider`:
 *
 * - Builds a `SandboxProvider` for the `container:docker` tier
 *   without spawning anything (the container only spawns on
 *   `provider.create()`, not at construction time).
 * - Throws `SandboxBackendNotImplementedError` for tiers that
 *   have not landed yet, with a label that names the missing
 *   tier and concrete service so consumers see exactly which
 *   backend is missing.
 * - Provider's `id` and `name` carry the tier so logs are legible
 *   when multiple providers run side by side.
 *
 * Docker-touching tests live in `backends/docker/__tests__/` and
 * skip when `docker` isn't available; this file stays pure-unit.
 */

import { describe, expect, it } from 'vitest'

import { SandboxBackendNotImplementedError, createSandboxProvider } from './index.js'

describe('createSandboxProvider', () => {
	it('builds a provider for container:docker without spawning anything', () => {
		const provider = createSandboxProvider({
			backend: { tier: 'container', runtime: 'docker', image: 'namzu-worker:latest' },
		})

		expect(provider.id).toContain('container')
		expect(provider.id).toContain('docker')
		expect(provider.name).toContain('container:docker')
	})

	it('treats container with no runtime as docker (default)', () => {
		const provider = createSandboxProvider({
			backend: { tier: 'container', image: 'namzu-worker:latest' },
		})

		expect(provider.id).toContain('docker')
	})

	it('throws SandboxBackendNotImplementedError for microvm:e2b until P3.3 lands', () => {
		expect(() =>
			createSandboxProvider({
				backend: { tier: 'microvm', service: 'e2b', apiKey: 'test' },
			}),
		).toThrow(SandboxBackendNotImplementedError)

		try {
			createSandboxProvider({
				backend: { tier: 'microvm', service: 'fly-machines', apiToken: 't', app: 'a', image: 'i' },
			})
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxBackendNotImplementedError)
			expect((err as SandboxBackendNotImplementedError).backend).toBe('microvm:fly-machines')
		}
	})

	it('throws for process tier until P3.4 lands, naming the engine in the label', () => {
		try {
			createSandboxProvider({ backend: { tier: 'process', engine: 'bubblewrap' } })
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxBackendNotImplementedError)
			expect((err as SandboxBackendNotImplementedError).backend).toBe('process:bubblewrap')
		}
	})

	it('throws for container:runsc until P3.5 lands', () => {
		try {
			createSandboxProvider({
				backend: { tier: 'container', runtime: 'runsc', image: 'i' },
			})
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxBackendNotImplementedError)
			expect((err as SandboxBackendNotImplementedError).backend).toBe('container:runsc')
		}
	})

	it('throws for passthrough tier until it lands', () => {
		try {
			createSandboxProvider({ backend: { tier: 'passthrough' } })
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxBackendNotImplementedError)
			expect((err as SandboxBackendNotImplementedError).backend).toBe('passthrough')
		}
	})
})
