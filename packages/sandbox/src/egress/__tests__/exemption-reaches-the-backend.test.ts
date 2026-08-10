import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DockerBackendInternalConfig } from '../../backends/docker/index.js'

/**
 * The escape hatch has to reach the thing it is an escape hatch from.
 *
 * `allowInwardFor` is the only remedy an operator has when the address screen
 * starts refusing a private host their allowlist used to reach. If it stops at
 * `ContainerBackendConfig` and never arrives at the proxy, the screen is a
 * denial with no way out — and nothing downstream of `buildDockerBackend`
 * runs without a Docker daemon, so the first person to find out would be
 * whoever was watching production traffic get refused.
 *
 * `brokeredCredentials` is the cautionary neighbour: it is declared on the
 * internal backend config, read by `egressProxyOptions`, and `createSandboxProvider`
 * has never passed it — so the credential brokering this whole boundary exists
 * for is unreachable through the provider today. That is a separate defect and
 * is not fixed here; it is why this case exists.
 */

const built: DockerBackendInternalConfig[] = []

vi.mock('../../backends/docker/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../backends/docker/index.js')>()
	return {
		...actual,
		buildDockerBackend: (config: DockerBackendInternalConfig) => {
			built.push(config)
			return actual.buildDockerBackend(config)
		},
	}
})

const { createSandboxProvider } = await import('../../index.js')

/** The minimum a container layout has to declare. */
function layout() {
	return { outputs: { source: { type: 'hostDir' as const, hostPath: '/host/out' } } }
}

describe('the inward exemption reaches the backend that builds the proxy', () => {
	beforeEach(() => {
		built.length = 0
	})

	it('carries the exemption a host configured', () => {
		createSandboxProvider({
			backend: {
				tier: 'container',
				image: 'namzu/sandbox:test',
				allowInwardFor: ['.internal.example'],
			},
			layout: layout(),
		} as never)

		expect(built).toHaveLength(1)
		expect(built[0]?.allowInwardFor).toEqual(['.internal.example'])
	})

	it('leaves it absent when the host configured none, so the screen applies', () => {
		createSandboxProvider({
			backend: { tier: 'container', image: 'namzu/sandbox:test' },
			layout: layout(),
		} as never)

		expect(built[0]?.allowInwardFor).toBeUndefined()
	})

	it('carries it on the gVisor runtime too, which is a second call site', () => {
		// Two `buildDockerBackend` calls sit in the same function, and a
		// property added to one of them is the shape this repo has a
		// convention about: finding an emitter is not evidence that every
		// path reaches it.
		createSandboxProvider({
			backend: {
				tier: 'container',
				runtime: 'runsc',
				image: 'namzu/sandbox:test',
				allowInwardFor: ['registry.corp'],
			},
			layout: layout(),
		} as never)

		expect(built[0]?.allowInwardFor).toEqual(['registry.corp'])
	})
})
